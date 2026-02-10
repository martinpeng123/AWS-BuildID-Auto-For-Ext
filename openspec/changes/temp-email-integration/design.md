# 临时邮箱集成 - 设计文档

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                         popup.html                          │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │ Gmail 别名配置   │  │ 临时邮箱配置     │  ← 模式切换      │
│  │ (隐藏/显示)      │  │ (隐藏/显示)      │                  │
│  └─────────────────┘  └─────────────────┘                  │
└────────────────────────────┬────────────────────────────────┘
                             │ chrome.runtime.sendMessage
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    service-worker.js                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              MailClientFactory                       │   │
│  │  ┌───────────────┐    ┌────────────────────┐        │   │
│  │  │GmailAliasClient│    │  TempEmailClient   │        │   │
│  │  │ (mail-api.js) │    │(temp-email-api.js) │        │   │
│  │  └───────────────┘    └────────────────────┘        │   │
│  └─────────────────────────────────────────────────────┘   │
│                             │                               │
│                             ▼                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              runSessionRegistration                  │   │
│  │   1. 获取配置 → 选择 MailClient                      │   │
│  │   2. createInbox() → 获取邮箱地址 + JWT              │   │
│  │   3. 启动 OIDC 授权流程                              │   │
│  │   4. waitForVerificationCode() → 轮询邮件            │   │
│  │   5. 发送验证码到 content.js                         │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ chrome.runtime.sendMessage
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                       content.js                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  handleVerificationCodePage()                        │   │
│  │   - 请求验证码 (GET_VERIFICATION_CODE)               │   │
│  │   - needManualInput: false → 自动填写                │   │
│  │   - needManualInput: true → 等待用户输入             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 文件变更详情

### 1. `lib/temp-email-api.js` (新建)

```javascript
/**
 * 临时邮箱客户端
 * 实现与 cloudflare_temp_email 的 API 交互
 */

// 配置常量
const POLL_INITIAL_INTERVAL_MS = 3000;
const POLL_MAX_INTERVAL_MS = 15000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_TIMEOUT_MS = 180000;
const POLL_JITTER_MS = 500;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;

// 主题过滤关键词
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

  configure(config) { /* 设置配置 */ }
  isConfigured() { /* 检查配置完整性 */ }

  async createInbox(options = {}) {
    // POST /admin/new_address
    // 返回 { address, jwt, createdAt }
  }

  async waitForVerificationCode(timeout = POLL_TIMEOUT_MS) {
    // 指数退避轮询 GET /api/mails
    // 提取验证码: metadata.auth_code > text > html
  }

  cancelPolling() {
    // 取消轮询
  }

  async deleteInbox() {
    // 清理状态
  }

  // 私有方法
  async _request(method, path, options = {}) { /* 带超时和重试的请求 */ }
  _extractCode(mails) { /* 验证码提取逻辑 */ }
  _matchesSubjectFilter(subject) { /* 主题过滤 */ }
  _calculateNextInterval(currentInterval) { /* 指数退避计算 */ }
}

export { TempEmailClient };
```

### 2. `background/service-worker.js` (修改)

**变更点:**

```javascript
// 新增 import
import { TempEmailClient } from '../lib/temp-email-api.js';

// 新增: MailClient 工厂函数
async function createMailClient() {
  const stored = await chrome.storage.local.get(['emailMode', 'tempEmailConfig', 'gmailAddress']);

  if (stored.emailMode === 'temp-email' && stored.tempEmailConfig) {
    const client = new TempEmailClient();
    client.configure(stored.tempEmailConfig);
    return { client, mode: 'temp-email' };
  }

  if (stored.gmailAddress) {
    const client = new GmailAliasClient({ baseEmail: stored.gmailAddress });
    return { client, mode: 'gmail' };
  }

  throw new Error('未配置邮箱服务');
}

// 修改: runSessionRegistration
async function runSessionRegistration(session) {
  // ...

  // 步骤 2: 获取邮箱客户端（根据模式）
  updateSession(session.id, { step: '初始化邮箱服务...' });
  const { client, mode } = await createMailClient();
  session.mailClient = client;
  session.emailMode = mode;

  // 创建邮箱
  const inboxResult = await client.createInbox();
  session.email = inboxResult.address;
  session.jwt = inboxResult.jwt;
  session.manualVerification = (mode === 'gmail'); // 临时邮箱模式下为 false

  // ... OIDC 流程 ...

  // 如果是临时邮箱模式，后台开始轮询验证码
  if (mode === 'temp-email') {
    session.codePollingPromise = client.waitForVerificationCode();
  }
}

// 修改: getVerificationCode 消息处理
case 'GET_VERIFICATION_CODE':
  if (session) {
    if (session.emailMode === 'temp-email') {
      // 临时邮箱模式: 检查轮询结果
      if (session.verificationCode) {
        sendResponse({ success: true, code: session.verificationCode, needManualInput: false });
      } else if (session.codePollingPromise) {
        // 等待轮询完成
        session.codePollingPromise.then(code => {
          session.verificationCode = code;
          sendResponse({ success: true, code, needManualInput: false });
        }).catch(err => {
          sendResponse({ success: false, needManualInput: true, error: err.message });
        });
        return true; // 异步响应
      }
    } else {
      // Gmail 模式: 保持现有逻辑
      sendResponse({ success: false, needManualInput: true, error: '请从 Gmail 获取验证码' });
    }
  }
  break;
```

### 3. `content/content.js` (修改)

**变更点:**

```javascript
// 修改: handleVerificationCodePage
async function handleVerificationCodePage() {
  updateStep('等待验证码...');

  // 轮询请求验证码
  const maxAttempts = 60; // 最多等待 3 分钟 (3s * 60)
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_VERIFICATION_CODE' });

      if (response.success && response.code) {
        // 自动填写验证码
        const input = document.querySelector('input[type="text"], input[name="code"]');
        if (input) {
          input.value = response.code;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          updateStep('验证码已自动填写');

          // 查找并点击提交按钮
          await new Promise(r => setTimeout(r, 500));
          const submitBtn = document.querySelector('button[type="submit"], button.submit');
          if (submitBtn) {
            submitBtn.click();
          }
          return true;
        }
      }

      if (response.needManualInput) {
        updateStep('请手动输入验证码');
        return false; // 等待用户手动输入
      }

    } catch (e) {
      console.warn('[Content] 获取验证码失败:', e);
    }

    await new Promise(r => setTimeout(r, 3000));
    attempts++;
  }

  updateStep('验证码获取超时，请手动输入');
  return false;
}
```

### 4. `popup/popup.html` (修改)

**新增 UI 结构:**

```html
<!-- 模式切换 -->
<div id="mode-section" class="section">
  <div class="mode-switch">
    <label class="mode-option">
      <input type="radio" name="email-mode" value="temp-email" checked>
      <span>临时邮箱 (自动)</span>
    </label>
    <label class="mode-option">
      <input type="radio" name="email-mode" value="gmail">
      <span>Gmail 别名 (手动)</span>
    </label>
  </div>
</div>

<!-- 临时邮箱配置 (默认显示) -->
<div id="temp-email-section" class="section">
  <div class="section-header">
    <h2>临时邮箱配置</h2>
  </div>
  <div class="config-form">
    <div class="form-row">
      <label>API 地址</label>
      <input type="url" id="temp-api-url" placeholder="https://api.example.com">
    </div>
    <div class="form-row">
      <label>Admin 密码</label>
      <input type="password" id="temp-admin-password" placeholder="输入 Admin 密码">
    </div>
    <div class="form-row">
      <label>邮箱域名</label>
      <input type="text" id="temp-domain" placeholder="例如: awsl.uk">
    </div>
    <div class="form-actions">
      <button id="temp-test-btn" class="btn-small">测试连接</button>
      <button id="temp-save-btn" class="btn-small btn-small-primary">保存</button>
    </div>
    <p class="config-status" id="temp-status"></p>
  </div>
</div>

<!-- Gmail 配置 (默认隐藏) -->
<div id="gmail-section" class="section gmail-section" style="display: none;">
  <!-- 现有 Gmail 配置内容 -->
</div>
```

### 5. `popup/popup.js` (修改)

**新增逻辑:**

```javascript
// 模式切换处理
document.querySelectorAll('input[name="email-mode"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const mode = e.target.value;
    await chrome.storage.local.set({ emailMode: mode });
    updateModeUI(mode);
  });
});

function updateModeUI(mode) {
  document.getElementById('temp-email-section').style.display =
    mode === 'temp-email' ? 'block' : 'none';
  document.getElementById('gmail-section').style.display =
    mode === 'gmail' ? 'block' : 'none';
}

// 临时邮箱配置保存
document.getElementById('temp-save-btn').addEventListener('click', async () => {
  const config = {
    apiUrl: document.getElementById('temp-api-url').value.trim().replace(/\/$/, ''),
    adminPassword: document.getElementById('temp-admin-password').value,
    domain: document.getElementById('temp-domain').value.trim()
  };

  // 验证必填项
  if (!config.apiUrl || !config.adminPassword || !config.domain) {
    showStatus('temp-status', '请填写所有必填项', 'error');
    return;
  }

  await chrome.storage.local.set({ tempEmailConfig: config });
  showStatus('temp-status', '配置已保存', 'success');
});

// 测试连接
document.getElementById('temp-test-btn').addEventListener('click', async () => {
  const config = {
    apiUrl: document.getElementById('temp-api-url').value.trim().replace(/\/$/, ''),
    adminPassword: document.getElementById('temp-admin-password').value,
    domain: document.getElementById('temp-domain').value.trim()
  };

  showStatus('temp-status', '测试连接中...', 'info');

  try {
    const response = await fetch(`${config.apiUrl}/admin/new_address`, {
      method: 'POST',
      headers: {
        'x-admin-auth': config.adminPassword,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        enablePrefix: true,
        name: `test_${Date.now()}`,
        domain: config.domain
      })
    });

    if (response.ok) {
      showStatus('temp-status', '连接成功！', 'success');
    } else if (response.status === 401 || response.status === 403) {
      showStatus('temp-status', 'Admin 密码错误', 'error');
    } else {
      showStatus('temp-status', `连接失败: ${response.status}`, 'error');
    }
  } catch (e) {
    showStatus('temp-status', `网络错误: ${e.message}`, 'error');
  }
});
```

### 6. `manifest.json` (修改)

**新增 host_permissions:**

```json
{
  "host_permissions": [
    "https://*.signin.aws/*",
    "https://*.aws.amazon.com/*",
    "https://signin.aws.amazon.com/*",
    "https://*.amazonaws.com/*",
    "https://mailfly.codeforge.top/*",
    "https://view.awsapps.com/*",
    "<all_urls>"  // 或添加用户配置的具体域名
  ]
}
```

**注意:** 由于用户的 API 地址是动态配置的，最安全的做法是使用 `<all_urls>` 或在安装时提示用户手动添加权限。

---

## 数据流

### 注册流程时序图

```
popup.js          service-worker.js        TempEmailClient        API Server         content.js
    |                     |                      |                     |                  |
    |--START_REGISTRATION--->                    |                     |                  |
    |                     |                      |                     |                  |
    |                     |--createMailClient()-->                     |                  |
    |                     |<--TempEmailClient----|                     |                  |
    |                     |                      |                     |                  |
    |                     |--createInbox()------>|                     |                  |
    |                     |                      |--POST /new_address->|                  |
    |                     |                      |<--{address,jwt}-----|                  |
    |                     |<--{address,jwt}------|                     |                  |
    |                     |                      |                     |                  |
    |                     |--openIncognitoWindow()...                  |                  |
    |                     |                      |                     |                  |
    |                     |--waitForCode()------>|                     |                  |
    |                     |                      |==POLLING START======|                  |
    |                     |                      |--GET /api/mails---->|                  |
    |                     |                      |<--[mails]-----------|                  |
    |                     |                      |--extractCode()      |                  |
    |                     |                      |  (retry if empty)   |                  |
    |                     |                      |--GET /api/mails---->|                  |
    |                     |                      |<--[mails with code]-|                  |
    |                     |<--code:123456--------|                     |                  |
    |                     |                      |                     |                  |
    |                     |                      |                     |  GET_VERIFICATION_CODE
    |                     |<-------------------------------------------------|
    |                     |--{code:123456,needManualInput:false}------------>|
    |                     |                      |                     |     |--fillInput()
    |                     |                      |                     |     |--clickSubmit()
```

---

## 配置存储结构

```javascript
// chrome.storage.local
{
  // 邮箱模式
  "emailMode": "temp-email", // "temp-email" | "gmail"

  // 临时邮箱配置
  "tempEmailConfig": {
    "apiUrl": "https://temp-email-api.example.com",
    "adminPassword": "xxx",
    "domain": "awsl.uk"
  },

  // Gmail 配置 (保持现有)
  "gmailAddress": "user@gmail.com",

  // 注册历史 (保持现有)
  "registrationHistory": [...]
}
```

---

*Generated by CCG:SPEC:PLAN at 2026-02-10*
