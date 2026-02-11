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
const SUBJECT_KEYWORDS = ['amazon', 'aws', 'verification', 'verify', 'code', '验证', '构建者', 'builder'];

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
        // 使用 admin/mails 接口，通过 address 参数过滤当前邮箱
        const queryParams = new URLSearchParams({
          limit: '20',
          offset: '0',
          address: this.address
        });
        const mails = await this._request('GET', `/admin/mails?${queryParams}`, {
          headers: { 'x-admin-auth': this.config.adminPassword }
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

    // 详细日志：请求信息
    const safeHeaders = { ...headers };
    if (safeHeaders['x-admin-auth']) {
      safeHeaders['x-admin-auth'] = '***HIDDEN***';
    }
    if (safeHeaders['Authorization']) {
      safeHeaders['Authorization'] = '***HIDDEN***';
    }
    console.log(`[TempEmailClient] ===== HTTP 请求 =====`);
    console.log(`[TempEmailClient] ${method} ${url}`);
    console.log(`[TempEmailClient] Headers:`, JSON.stringify(safeHeaders, null, 2));
    if (options.body) {
      console.log(`[TempEmailClient] Body:`, JSON.stringify(options.body, null, 2));
    }

    let lastError = null;

    // MAX_RETRIES 表示最大重试次数，总尝试次数 = 1 + MAX_RETRIES
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      if (retry > 0) {
        console.log(`[TempEmailClient] 重试 ${retry}/${MAX_RETRIES - 1}...`);
      }

      try {
        const fetchOptions = {
          method,
          headers,
          signal: controller.signal
        };

        if (options.body && method !== 'GET') {
          fetchOptions.body = JSON.stringify(options.body);
        }

        const startTime = Date.now();
        const response = await fetch(url, fetchOptions);
        const elapsed = Date.now() - startTime;

        console.log(`[TempEmailClient] ===== HTTP 响应 =====`);
        console.log(`[TempEmailClient] Status: ${response.status} ${response.statusText}`);
        console.log(`[TempEmailClient] 耗时: ${elapsed}ms`);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.log(`[TempEmailClient] Error Body: ${errorText}`);
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

        const data = await response.json();
        console.log(`[TempEmailClient] Response Data:`, JSON.stringify(data, null, 2).slice(0, 1000));
        if (JSON.stringify(data).length > 1000) {
          console.log(`[TempEmailClient] ... (响应数据已截断，共 ${JSON.stringify(data).length} 字符)`);
        }
        console.log(`[TempEmailClient] ===== 请求完成 =====`);

        return data;
      } catch (error) {
        if (error.name === 'AbortError') {
          error.message = '请求超时';
        }

        console.log(`[TempEmailClient] 请求错误: ${error.message}`);
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

  _extractCode(response) {
    // 适配 /admin/mails 响应格式: { results: [...], count: n }
    const mails = response?.results || response;

    // 调试日志：显示收到的邮件信息
    console.log('[TempEmailClient] _extractCode 响应结构:', {
      hasResults: !!response?.results,
      count: response?.count,
      mailsLength: Array.isArray(mails) ? mails.length : 0
    });

    if (!Array.isArray(mails) || mails.length === 0) {
      console.log('[TempEmailClient] 无邮件，继续轮询...');
      return null;
    }

    // 打印所有邮件的关键信息用于调试
    mails.forEach((mail, idx) => {
      const subject = this._parseSubjectFromRaw(mail.raw) || '(无主题)';
      console.log(`[TempEmailClient] 邮件[${idx}] ID: ${mail.id}`);
      console.log(`[TempEmailClient] 邮件[${idx}] 地址: ${mail.address}`);
      console.log(`[TempEmailClient] 邮件[${idx}] 主题: "${subject}"`);
      console.log(`[TempEmailClient] 邮件[${idx}] 时间: ${mail.created_at}`);
      if (mail.metadata?.auth_code) {
        console.log(`[TempEmailClient] 邮件[${idx}] AI提取验证码: ${mail.metadata.auth_code}`);
      }
    });

    const filteredMails = mails.filter(mail => {
      // 新创建的邮箱不会有旧邮件，无需时间过滤
      // 仅通过主题关键词过滤确保是 AWS 验证邮件
      const subject = this._parseSubjectFromRaw(mail.raw) || '';
      const subjectMatch = this._matchesSubjectFilter(subject);
      if (!subjectMatch) {
        console.log(`[TempEmailClient] 邮件被主题过滤: "${subject}" (不含关键词: ${SUBJECT_KEYWORDS.join(', ')})`);
      }
      return subjectMatch;
    });

    console.log(`[TempEmailClient] 过滤后剩余邮件数: ${filteredMails.length}`);

    // 按创建时间排序（最新的在前），确保幂等性
    filteredMails.sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeB - timeA;
    });

    for (const mail of filteredMails) {
      // 优先使用 AI 提取的验证码，但需校验格式
      if (mail.metadata?.auth_code && /^\d{6}$/.test(mail.metadata.auth_code)) {
        console.log(`[TempEmailClient] 使用 AI 提取的验证码: ${mail.metadata.auth_code}`);
        return mail.metadata.auth_code;
      }

      // 从 raw 字段提取内容
      const textContent = this._parseContentFromRaw(mail.raw);
      console.log(`[TempEmailClient] 邮件内容预览 (前300字符): ${textContent.slice(0, 300).replace(/\s+/g, ' ')}`);

      // 方法1: 从 HTML 中提取 <div class="code">...</div> 中的验证码
      const htmlCodeMatch = mail.raw?.match(/<div[^>]*class="code"[^>]*>(\d{6})<\/div>/i);
      if (htmlCodeMatch) {
        console.log(`[TempEmailClient] 从 HTML code div 提取验证码: ${htmlCodeMatch[1]}`);
        return htmlCodeMatch[1];
      }

      // 方法2: 支持中英文验证码关键词
      const contextMatch = textContent.match(/(?:verification|code|verify|验证码|驗證碼)[^0-9]*(\d{6})/i);
      if (contextMatch) {
        console.log(`[TempEmailClient] 正则匹配到验证码: ${contextMatch[1]}`);
        return contextMatch[1];
      }

      // 方法3: 简单匹配6位数字
      const simpleMatch = textContent.match(/\b(\d{6})\b/);
      if (simpleMatch) {
        console.log(`[TempEmailClient] 简单匹配到验证码: ${simpleMatch[1]}`);
        return simpleMatch[1];
      }

      console.log('[TempEmailClient] 未能从邮件内容中提取验证码');
    }

    console.log('[TempEmailClient] 所有邮件均未提取到验证码');
    return null;
  }

  /**
   * 从 raw 邮件内容解析 Subject
   */
  _parseSubjectFromRaw(raw) {
    if (!raw) return null;

    // 匹配 Subject 头，支持多行折叠
    const subjectMatch = raw.match(/^Subject:\s*(.+?)(?:\r?\n(?![\t ])|\r?\n\r?\n)/ms);
    if (!subjectMatch) return null;

    let subject = subjectMatch[1].replace(/\r?\n\s+/g, ' ').trim();

    // 解码 RFC 2047 编码（如 =?UTF-8?B?...?=）
    subject = this._decodeRfc2047(subject);

    console.log(`[TempEmailClient] 解析到 Subject: "${subject}"`);
    return subject;
  }

  /**
   * 从 raw 邮件内容解析正文
   */
  _parseContentFromRaw(raw) {
    if (!raw) return '';

    let content = '';

    // 尝试提取 base64 编码的 text/plain 部分
    const base64Match = raw.match(/Content-Type:\s*text\/plain[^]*?Content-Transfer-Encoding:\s*base64[^]*?\r?\n\r?\n([A-Za-z0-9+/=\s]+?)(?:\r?\n--|\r?\n\r?\n)/s);
    if (base64Match) {
      try {
        const base64Content = base64Match[1].replace(/\s/g, '');
        content = atob(base64Content);
        // UTF-8 解码
        content = decodeURIComponent(escape(content));
      } catch (e) {
        console.warn('[TempEmailClient] Base64 解码失败:', e.message);
      }
    }

    // 如果没有解析到内容，尝试直接从 raw 中搜索验证码模式
    if (!content) {
      content = raw;
    }

    return content;
  }

  /**
   * 解码 RFC 2047 编码的字符串
   */
  _decodeRfc2047(str) {
    return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          // Base64 编码
          const decoded = atob(text);
          return decodeURIComponent(escape(decoded));
        } else if (encoding.toUpperCase() === 'Q') {
          // Quoted-Printable 编码
          return text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, hex) =>
            String.fromCharCode(parseInt(hex, 16))
          );
        }
      } catch (e) {
        console.warn('[TempEmailClient] RFC 2047 解码失败:', e.message);
      }
      return match;
    });
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
