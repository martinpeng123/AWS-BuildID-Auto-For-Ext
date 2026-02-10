# 临时邮箱集成 - 执行任务列表

## 任务概览

| # | 任务 | 依赖 | 预估代码量 | 状态 |
|---|------|------|-----------|------|
| T1 | 创建 TempEmailClient 类 | - | ~200 行 | [x] 已完成 |
| T2 | 修改 manifest.json 添加权限 | - | ~5 行 | [x] 已完成 |
| T3 | 修改 popup.html 添加配置 UI | - | ~60 行 | [x] 已完成 |
| T4 | 修改 popup.css 添加样式 | T3 | ~40 行 | [x] 已完成 |
| T5 | 修改 popup.js 添加配置逻辑 | T3 | ~80 行 | [x] 已完成 |
| T6 | 修改 service-worker.js 集成客户端 | T1 | ~60 行 | [x] 已完成 |
| T7 | 修改 content.js 自动填写逻辑 | T6 | ~40 行 | [x] 已完成 |
| T8 | 端到端测试 | T1-T7 | - | |

---

## T1: 创建 TempEmailClient 类

**文件**: `lib/temp-email-api.js` (新建)

**输入**: 无

**输出**: 完整的 TempEmailClient 实现

**步骤**:
1. 创建文件 `lib/temp-email-api.js`
2. 定义常量:
   ```javascript
   const POLL_INITIAL_INTERVAL_MS = 3000;
   const POLL_MAX_INTERVAL_MS = 15000;
   const POLL_BACKOFF_FACTOR = 1.5;
   const POLL_TIMEOUT_MS = 180000;
   const POLL_JITTER_MS = 500;
   const MAX_RETRIES = 3;
   const REQUEST_TIMEOUT_MS = 15000;
   const SUBJECT_KEYWORDS = ['amazon', 'aws', 'verification', 'verify', 'code'];
   ```
3. 实现 `TempEmailClient` 类:
   - `constructor()`: 初始化状态
   - `configure(config)`: 设置 apiUrl, adminPassword, domain
   - `isConfigured()`: 返回 config 完整性
   - `createInbox(options)`: POST /admin/new_address
   - `waitForVerificationCode(timeout)`: 指数退避轮询
   - `cancelPolling()`: 设置 abortController.abort()
   - `deleteInbox()`: 清理内存状态
   - `getAddress()`, `getStats()`: 状态获取
   - `_request(method, path, options)`: 带超时和重试的 fetch 封装
   - `_extractCode(mails)`: 从邮件提取验证码
   - `_matchesSubjectFilter(subject)`: 主题关键词过滤
   - `_calculateNextInterval(current)`: 指数退避计算
4. 导出 `TempEmailClient`

**验证**:
- `new TempEmailClient()` 不报错
- `configure({apiUrl, adminPassword, domain})` 后 `isConfigured()` 返回 true
- 缺少任一配置项时 `isConfigured()` 返回 false

---

## T2: 修改 manifest.json

**文件**: `manifest.json`

**输入**: 现有 manifest.json

**输出**: 添加 `<all_urls>` 或通配符权限

**步骤**:
1. 打开 `manifest.json`
2. 在 `host_permissions` 数组末尾添加:
   ```json
   "https://*/*"
   ```
   或使用更宽松的:
   ```json
   "<all_urls>"
   ```
3. 保存文件

**验证**:
- 扩展重新加载无错误
- 可以对任意 HTTPS 域名发起请求

---

## T3: 修改 popup.html

**文件**: `popup/popup.html`

**输入**: 现有 popup.html

**输出**: 添加模式切换和临时邮箱配置 UI

**步骤**:
1. 在 `<div id="gmail-section">` **之前** 添加:
   ```html
   <!-- 模式切换 -->
   <div id="mode-section" class="section">
     <div class="section-header">
       <h2>邮箱模式</h2>
     </div>
     <div class="mode-switch">
       <label class="mode-option">
         <input type="radio" name="email-mode" value="temp-email">
         <span>临时邮箱 (自动验证码)</span>
       </label>
       <label class="mode-option">
         <input type="radio" name="email-mode" value="gmail">
         <span>Gmail 别名 (手动验证码)</span>
       </label>
     </div>
   </div>

   <!-- 临时邮箱配置 -->
   <div id="temp-email-section" class="section" style="display: none;">
     <div class="section-header">
       <h2>临时邮箱配置</h2>
     </div>
     <div class="temp-email-config">
       <div class="config-row">
         <label>API 地址</label>
         <input type="url" id="temp-api-url" placeholder="https://api.example.com" class="config-input">
       </div>
       <div class="config-row">
         <label>Admin 密码</label>
         <input type="password" id="temp-admin-password" placeholder="输入 Admin 密码" class="config-input">
       </div>
       <div class="config-row">
         <label>邮箱域名</label>
         <input type="text" id="temp-domain" placeholder="例如: awsl.uk" class="config-input">
       </div>
       <div class="config-actions">
         <button id="temp-test-btn" class="btn-small">测试连接</button>
         <button id="temp-save-btn" class="btn-small btn-small-primary">保存配置</button>
       </div>
       <p class="config-status" id="temp-config-status"></p>
     </div>
   </div>
   ```
2. 保存文件

**验证**:
- 打开 popup 可以看到模式切换区域
- 输入框和按钮正常显示

---

## T4: 修改 popup.css

**文件**: `popup/popup.css`

**输入**: 现有 popup.css

**输出**: 添加模式切换和临时邮箱配置样式

**步骤**:
1. 在文件末尾添加:
   ```css
   /* 模式切换 */
   .mode-switch {
     display: flex;
     gap: 12px;
   }

   .mode-option {
     flex: 1;
     display: flex;
     align-items: center;
     gap: 8px;
     padding: 10px 12px;
     border: 1px solid #ddd;
     border-radius: 6px;
     cursor: pointer;
     transition: all 0.2s;
   }

   .mode-option:has(input:checked) {
     border-color: #007bff;
     background: #f0f7ff;
   }

   .mode-option input {
     margin: 0;
   }

   /* 临时邮箱配置 */
   .temp-email-config {
     display: flex;
     flex-direction: column;
     gap: 12px;
   }

   .config-row {
     display: flex;
     flex-direction: column;
     gap: 4px;
   }

   .config-row label {
     font-size: 12px;
     color: #666;
   }

   .config-input {
     padding: 8px 10px;
     border: 1px solid #ddd;
     border-radius: 4px;
     font-size: 13px;
   }

   .config-input:focus {
     outline: none;
     border-color: #007bff;
   }

   .config-actions {
     display: flex;
     gap: 8px;
     margin-top: 4px;
   }

   .config-status {
     font-size: 12px;
     margin: 4px 0 0;
     min-height: 16px;
   }

   .config-status.success { color: #28a745; }
   .config-status.error { color: #dc3545; }
   .config-status.info { color: #007bff; }
   ```
2. 保存文件

**验证**:
- 模式切换按钮有正确的视觉反馈
- 配置表单布局整齐

---

## T5: 修改 popup.js

**文件**: `popup/popup.js`

**输入**: 现有 popup.js

**输出**: 添加模式切换和配置保存逻辑

**步骤**:
1. 在文件顶部添加初始化逻辑:
   ```javascript
   // 初始化模式切换
   async function initEmailMode() {
     const stored = await chrome.storage.local.get(['emailMode', 'tempEmailConfig']);
     const mode = stored.emailMode || 'temp-email';

     // 设置单选按钮
     document.querySelector(`input[value="${mode}"]`).checked = true;
     updateModeUI(mode);

     // 填充临时邮箱配置
     if (stored.tempEmailConfig) {
       document.getElementById('temp-api-url').value = stored.tempEmailConfig.apiUrl || '';
       document.getElementById('temp-admin-password').value = stored.tempEmailConfig.adminPassword || '';
       document.getElementById('temp-domain').value = stored.tempEmailConfig.domain || '';
     }
   }

   function updateModeUI(mode) {
     document.getElementById('temp-email-section').style.display =
       mode === 'temp-email' ? 'block' : 'none';
     document.getElementById('gmail-section').style.display =
       mode === 'gmail' ? 'block' : 'none';
   }

   function showConfigStatus(elementId, message, type) {
     const el = document.getElementById(elementId);
     el.textContent = message;
     el.className = `config-status ${type}`;
   }
   ```

2. 添加事件监听器:
   ```javascript
   // 模式切换
   document.querySelectorAll('input[name="email-mode"]').forEach(radio => {
     radio.addEventListener('change', async (e) => {
       const mode = e.target.value;
       await chrome.storage.local.set({ emailMode: mode });
       updateModeUI(mode);
     });
   });

   // 保存临时邮箱配置
   document.getElementById('temp-save-btn').addEventListener('click', async () => {
     const config = {
       apiUrl: document.getElementById('temp-api-url').value.trim().replace(/\/$/, ''),
       adminPassword: document.getElementById('temp-admin-password').value,
       domain: document.getElementById('temp-domain').value.trim()
     };

     if (!config.apiUrl || !config.adminPassword || !config.domain) {
       showConfigStatus('temp-config-status', '请填写所有配置项', 'error');
       return;
     }

     await chrome.storage.local.set({ tempEmailConfig: config });
     showConfigStatus('temp-config-status', '配置已保存', 'success');
   });

   // 测试连接
   document.getElementById('temp-test-btn').addEventListener('click', async () => {
     const apiUrl = document.getElementById('temp-api-url').value.trim().replace(/\/$/, '');
     const adminPassword = document.getElementById('temp-admin-password').value;
     const domain = document.getElementById('temp-domain').value.trim();

     if (!apiUrl || !adminPassword || !domain) {
       showConfigStatus('temp-config-status', '请先填写配置', 'error');
       return;
     }

     showConfigStatus('temp-config-status', '测试连接中...', 'info');

     try {
       const response = await fetch(`${apiUrl}/admin/new_address`, {
         method: 'POST',
         headers: {
           'x-admin-auth': adminPassword,
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({
           enablePrefix: true,
           name: `test_${Date.now()}`,
           domain: domain
         })
       });

       if (response.ok) {
         showConfigStatus('temp-config-status', '✓ 连接成功', 'success');
       } else if (response.status === 401 || response.status === 403) {
         showConfigStatus('temp-config-status', '✗ Admin 密码错误', 'error');
       } else {
         const text = await response.text();
         showConfigStatus('temp-config-status', `✗ 错误: ${response.status}`, 'error');
       }
     } catch (e) {
       showConfigStatus('temp-config-status', `✗ 网络错误: ${e.message}`, 'error');
     }
   });
   ```

3. 在 DOMContentLoaded 回调中添加 `initEmailMode()` 调用

**验证**:
- 切换模式后正确显示/隐藏配置区
- 保存配置后刷新仍能加载
- 测试连接显示正确结果

---

## T6: 修改 service-worker.js

**文件**: `background/service-worker.js`

**输入**: 现有 service-worker.js

**输出**: 集成 TempEmailClient

**步骤**:
1. 添加 import:
   ```javascript
   import { TempEmailClient } from '../lib/temp-email-api.js';
   ```

2. 添加工厂函数:
   ```javascript
   async function createMailClient() {
     const stored = await chrome.storage.local.get(['emailMode', 'tempEmailConfig', 'gmailAddress']);

     if (stored.emailMode === 'temp-email' && stored.tempEmailConfig) {
       const client = new TempEmailClient();
       client.configure(stored.tempEmailConfig);
       if (!client.isConfigured()) {
         throw new Error('临时邮箱配置不完整');
       }
       return { client, mode: 'temp-email' };
     }

     if (stored.gmailAddress) {
       const client = new GmailAliasClient({ baseEmail: stored.gmailAddress });
       return { client, mode: 'gmail' };
     }

     throw new Error('未配置邮箱服务');
   }
   ```

3. 修改 `runSessionRegistration` 函数中的邮箱创建逻辑:
   - 替换直接使用 `GmailAliasClient` 为调用 `createMailClient()`
   - 根据返回的 `mode` 设置 `session.manualVerification`
   - 如果是临时邮箱模式，启动验证码轮询

4. 修改 `GET_VERIFICATION_CODE` 消息处理:
   - 检查 `session.emailMode`
   - 临时邮箱模式返回 `{ success: true, code, needManualInput: false }`
   - Gmail 模式保持现有逻辑

**验证**:
- 临时邮箱模式下能创建邮箱
- 验证码能被自动获取

---

## T7: 修改 content.js

**文件**: `content/content.js`

**输入**: 现有 content.js

**输出**: 支持自动填写验证码

**步骤**:
1. 找到验证码处理相关函数
2. 修改为支持自动填写:
   ```javascript
   async function handleVerificationCodeStep() {
     updateStep('获取验证码...');

     // 短轮询请求验证码
     for (let i = 0; i < 60; i++) { // 最多 3 分钟
       try {
         const response = await chrome.runtime.sendMessage({ type: 'GET_VERIFICATION_CODE' });

         if (response.success && response.code && !response.needManualInput) {
           // 自动填写
           const input = document.querySelector('input[type="text"][name*="code"], input.verification-code');
           if (input) {
             input.value = response.code;
             input.dispatchEvent(new Event('input', { bubbles: true }));
             input.dispatchEvent(new Event('change', { bubbles: true }));
             updateStep('验证码已填写: ' + response.code);

             // 等待后点击提交
             await new Promise(r => setTimeout(r, 800));
             const btn = document.querySelector('button[type="submit"]');
             if (btn) btn.click();
             return true;
           }
         }

         if (response.needManualInput) {
           updateStep('请手动输入验证码');
           return false;
         }
       } catch (e) {
         console.warn('[Content] 验证码请求错误:', e);
       }

       await new Promise(r => setTimeout(r, 3000));
     }

     updateStep('验证码获取超时');
     return false;
   }
   ```

**验证**:
- 临时邮箱模式下验证码自动填入
- Gmail 模式下仍提示手动输入

---

## T8: 端到端测试

**前置条件**: T1-T7 全部完成

**测试用例**:

1. **临时邮箱配置测试**
   - 输入正确配置 → 测试连接成功 → 保存成功
   - 输入错误密码 → 测试连接失败
   - 缺少必填项 → 保存失败提示

2. **模式切换测试**
   - 切换到临时邮箱 → Gmail 配置隐藏
   - 切换到 Gmail → 临时邮箱配置隐藏
   - 刷新后模式保持

3. **临时邮箱注册流程**
   - 配置临时邮箱 → 开始注册
   - 邮箱自动创建
   - 验证码自动获取
   - 验证码自动填入
   - 注册完成

4. **Gmail 模式回归测试**
   - 切换到 Gmail 模式
   - 开始注册
   - 验证码页面提示手动输入
   - 手动输入验证码
   - 注册完成

5. **错误恢复测试**
   - 网络断开 → 重试
   - API 超时 → 重试
   - 验证码获取超时 → 提示手动输入

---

*Generated by CCG:SPEC:PLAN at 2026-02-10*
