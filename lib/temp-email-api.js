/**
 * 临时邮箱客户端
 * 与 cloudflare_temp_email API 交互
 */

const POLL_INITIAL_INTERVAL_MS = 3000;
const POLL_MAX_INTERVAL_MS = 15000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_TIMEOUT_MS = 180000;
const POLL_JITTER_MS = 500;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;
const SUBJECT_KEYWORDS = ['amazon', 'aws', 'verification', 'verify', 'code'];

class TempEmailClient {
  constructor() {
    this.config = null;
    this.address = null;
    this.jwt = null;
    this.createdAt = null;
    this.abortController = null;
    this.pollStats = { attempts: 0, errors: 0, lastInterval: 0, startedAt: 0 };
  }

  configure(config) {
    let apiUrl = config.apiUrl?.trim().replace(/\/$/, '') || '';

    if (apiUrl) {
      try {
        const url = new URL(apiUrl);
        if (url.protocol !== 'https:') {
          throw new Error('API URL 必须使用 HTTPS');
        }
        apiUrl = url.origin;
      } catch (e) {
        if (e.message.includes('HTTPS')) throw e;
        throw new Error('无效的 API URL 格式');
      }
    }

    this.config = {
      apiUrl,
      adminPassword: config.adminPassword || '',
      domain: config.domain || ''
    };
  }

  isConfigured() {
    return !!(this.config?.apiUrl && this.config?.adminPassword && this.config?.domain);
  }

  async createInbox(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('临时邮箱未配置');
    }

    const name = options.name || `aws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const enablePrefix = options.enablePrefix !== false;

    const response = await this._request('POST', '/admin/new_address', {
      headers: { 'x-admin-auth': this.config.adminPassword },
      body: { enablePrefix, name, domain: this.config.domain }
    });

    if (!response.address || typeof response.address !== 'string') {
      throw new Error('API 返回的邮箱地址无效');
    }
    if (!response.jwt || typeof response.jwt !== 'string') {
      throw new Error('API 返回的 JWT 无效');
    }

    this.address = response.address;
    this.jwt = response.jwt;
    this.createdAt = Date.now();

    return {
      address: this.address,
      jwt: this.jwt,
      createdAt: this.createdAt
    };
  }

  async waitForVerificationCode(timeout = POLL_TIMEOUT_MS) {
    if (!this.jwt) {
      throw new Error('邮箱未创建，无法获取验证码');
    }

    this.cancelPolling();
    this.abortController = new AbortController();
    const currentSignal = this.abortController.signal;
    this.pollStats = { attempts: 0, errors: 0, lastInterval: POLL_INITIAL_INTERVAL_MS, startedAt: Date.now() };

    const startTime = Date.now();
    let currentInterval = POLL_INITIAL_INTERVAL_MS;

    while (Date.now() - startTime < timeout) {
      if (currentSignal.aborted) {
        throw new Error('轮询已取消');
      }

      this.pollStats.attempts++;

      try {
        const mails = await this._request('GET', '/api/mails', {
          headers: { Authorization: `Bearer ${this.jwt}` }
        });

        const code = this._extractCode(mails);
        if (code) {
          return code;
        }
      } catch (error) {
        this.pollStats.errors++;
        console.warn('[TempEmailClient] 轮询错误:', error.message);
      }

      currentInterval = this._calculateNextInterval(currentInterval);
      this.pollStats.lastInterval = currentInterval;

      // 仅正向抖动，保证间隔单调递增
      const jitter = Math.random() * POLL_JITTER_MS;
      const sleepMs = currentInterval + jitter;
      await this._sleep(sleepMs);
    }

    throw new Error('验证码获取超时');
  }

  cancelPolling() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async deleteInbox() {
    this.address = null;
    this.jwt = null;
    this.createdAt = null;
    this.cancelPolling();
  }

  getAddress() {
    return this.address;
  }

  getStats() {
    return { ...this.pollStats };
  }

  async _request(method, path, options = {}) {
    const url = `${this.config.apiUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    let lastError = null;

    // MAX_RETRIES 表示最大重试次数，总尝试次数 = 1 + MAX_RETRIES
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const fetchOptions = {
          method,
          headers,
          signal: controller.signal
        };

        if (options.body && method !== 'GET') {
          fetchOptions.body = JSON.stringify(options.body);
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const error = new Error(`HTTP ${response.status}: ${errorText}`);
          error.status = response.status;

          if ([400, 401, 403, 404].includes(response.status)) {
            throw error;
          }

          lastError = error;
          if (retry < MAX_RETRIES - 1) {
            await this._sleep(1000 * (retry + 1));
            continue;
          }
          throw error;
        }

        return await response.json();
      } catch (error) {
        if (error.name === 'AbortError') {
          error.message = '请求超时';
        }

        lastError = error;

        if (error.status && [400, 401, 403, 404].includes(error.status)) {
          throw error;
        }

        if (retry < MAX_RETRIES - 1) {
          await this._sleep(1000 * (retry + 1));
          continue;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || new Error('请求失败');
  }

  _extractCode(mails) {
    if (!Array.isArray(mails) || mails.length === 0) {
      return null;
    }

    const filteredMails = mails.filter(mail => {
      if (mail.created_at && this.createdAt) {
        const mailTime = new Date(mail.created_at).getTime();
        if (mailTime < this.createdAt) {
          return false;
        }
      }
      return this._matchesSubjectFilter(mail.subject || '');
    });

    // 按创建时间排序（最新的在前），确保幂等性
    filteredMails.sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeB - timeA;
    });

    for (const mail of filteredMails) {
      // 优先使用 AI 提取的验证码，但需校验格式
      if (mail.metadata?.auth_code && /^\d{6}$/.test(mail.metadata.auth_code)) {
        return mail.metadata.auth_code;
      }

      const textContent = mail.text || mail.html || '';
      const contextMatch = textContent.match(/(?:verification|code|verify)[^0-9]*(\d{6})/i);
      if (contextMatch) {
        return contextMatch[1];
      }

      const simpleMatch = textContent.match(/\b(\d{6})\b/);
      if (simpleMatch) {
        return simpleMatch[1];
      }
    }

    return null;
  }

  _matchesSubjectFilter(subject) {
    const lowerSubject = subject.toLowerCase();
    return SUBJECT_KEYWORDS.some(keyword => lowerSubject.includes(keyword));
  }

  _calculateNextInterval(currentInterval) {
    const nextInterval = currentInterval * POLL_BACKOFF_FACTOR;
    return Math.min(nextInterval, POLL_MAX_INTERVAL_MS);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { TempEmailClient };
