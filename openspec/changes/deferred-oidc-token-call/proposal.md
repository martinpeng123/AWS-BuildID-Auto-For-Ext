# OPSX 提案: 延迟 OIDC Token 调用时机

## 需求背景

当前实现中，OIDC Token 轮询（调用 `https://oidc.us-east-1.amazonaws.com/token`）在获取设备授权后立即开始，与页面导航并行执行。这导致：

1. **不必要的 API 调用**: 在用户授权完成之前，Token 轮询会持续发送请求，每次返回 `authorization_pending`
2. **资源浪费**: 后台持续轮询消耗网络资源和 API 配额
3. **调试困难**: 大量 pending 状态的请求混杂在日志中

## 当前流程分析

### 现有调用链（service-worker.js:290-394）

```
runSessionRegistration()
  → 步骤3: session.oidcClient.quickAuth()     // 注册客户端 + 设备授权
  → 步骤4: chrome.windows.create()            // 打开无痕窗口
  → 步骤5: 启动验证码轮询（temp-email模式）
  → 步骤6: pollSessionToken()                  // 立即开始 Token 轮询 ← 问题点
```

### Token 轮询逻辑（service-worker.js:458-482）

```javascript
async function pollSessionToken(session) {
  while (...) {
    const result = await session.oidcClient.getToken();  // 调用 /token
    if (result) return result;
    await sleep(pollInterval);
  }
}
```

## 目标页面识别

OIDC Device Flow 的授权完成发生在以下页面：

| 页面类型 | URL 特征 | 检测方式 |
|---------|---------|---------|
| 设备确认页 | `device.sso` / `confirm` | `PAGE_TYPES.DEVICE_CONFIRM` |
| 授权页 | `awsapps.com` + "Allow access" | `PAGE_TYPES.ALLOW_ACCESS` |
| 完成页 | "successfully authorized" | `PAGE_TYPES.COMPLETE` |

**关键节点**: 用户点击 "Allow access" 按钮后，授权才真正完成。

## 约束集合

### 硬约束（必须遵守）

| ID | 约束 | 来源 |
|----|------|------|
| HC-1 | Token 轮询必须在用户点击 "Allow access" 后才开始 | 需求定义 |
| HC-2 | 不能破坏现有多窗口并发注册机制 | 现有架构 |
| HC-3 | 每个 session 的 Token 轮询必须独立（session 隔离） | 并发需求 |
| HC-4 | Token 轮询超时机制（10分钟）必须保留 | service-worker.js:462 |
| HC-5 | Content Script 与 Service Worker 通信使用 `chrome.runtime.sendMessage` | Chrome 扩展架构 |

### 软约束（建议遵守）

| ID | 约束 | 来源 |
|----|------|------|
| SC-1 | 优先复用现有的 `AUTH_COMPLETED` 消息类型 | content.js:684/694 |
| SC-2 | 避免在 ALLOW_ACCESS 页面之前发起任何 /token 请求 | 性能优化 |
| SC-3 | 轮询启动信号应该具有幂等性（防止重复触发） | 健壮性 |

## 解决方案方向

### 方案 A: 事件驱动（推荐）

- Content Script 检测到 ALLOW_ACCESS 页面点击后，发送 `AUTH_COMPLETED` 消息
- Service Worker 收到消息后，才启动 Token 轮询
- 复用现有消息通道，改动最小

### 方案 B: 页面 URL 监听

- Service Worker 监听 `chrome.webNavigation` 事件
- 检测到授权完成页面 URL 后启动轮询
- 需要额外权限，增加复杂度

### 方案 C: 混合检测

- Content Script 监听页面内容变化
- 检测到 "successfully authorized" 文本后触发
- 更可靠但延迟稍高

## 推荐方案详细设计

采用 **方案 A**，具体修改：

### 1. Content Script (content.js)

现有逻辑已经在 `handleAllowAccessPage()` 中发送 `AUTH_COMPLETED`，无需修改。

### 2. Service Worker (service-worker.js)

```javascript
// 修改 runSessionRegistration()
async function runSessionRegistration(session) {
  // ... 步骤 1-5 不变 ...

  // 步骤 6: 等待授权完成信号，然后开始轮询 Token
  session.status = 'waiting_auth';
  updateSession(session.id, { step: '等待用户授权...' });

  // 等待 AUTH_COMPLETED 消息
  await waitForAuthCompleted(session);

  // 授权完成，开始轮询 Token
  session.status = 'polling_token';
  updateSession(session.id, { step: '获取 Token...' });

  const tokenResult = await pollSessionToken(session);
  // ... 后续处理不变 ...
}

// 新增函数
function waitForAuthCompleted(session) {
  return new Promise((resolve, reject) => {
    session.authCompletedResolve = resolve;
    // 超时保护（10分钟）
    session.authCompletedTimeout = setTimeout(() => {
      reject(new Error('等待授权超时'));
    }, 600000);
  });
}
```

### 3. 消息处理修改

```javascript
case 'AUTH_COMPLETED':
  if (session) {
    // 清除超时计时器
    if (session.authCompletedTimeout) {
      clearTimeout(session.authCompletedTimeout);
    }
    // 触发 Token 轮询
    if (session.authCompletedResolve) {
      session.authCompletedResolve();
    }
    updateSession(session.id, { step: '授权完成，开始获取 Token...' });
  }
  sendResponse({ success: true });
  break;
```

## 成功验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | 扩展启动后，在用户点击 "Allow access" 之前，不发送任何 /token 请求 | Network 面板检查 |
| AC-2 | 用户点击 "Allow access" 后 2 秒内，开始 Token 轮询 | 日志时间戳 |
| AC-3 | 多窗口并发注册场景下，每个窗口独立触发轮询 | 多窗口测试 |
| AC-4 | 用户未授权超时（10分钟）时，正确报错并终止会话 | 超时测试 |
| AC-5 | 现有功能回归测试全部通过 | 手动测试 |

## 影响范围

### 文件修改清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `background/service-worker.js` | 修改 | runSessionRegistration 流程重构 |
| `content/content.js` | 无修改 | 现有 AUTH_COMPLETED 机制已满足需求 |
| `lib/oidc-api.js` | 无修改 | Token 轮询逻辑保持不变 |

### 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Content Script 未能正确检测授权完成页面 | 中 | 增加多重检测（URL + 文本 + 按钮） |
| 消息丢失导致永久等待 | 低 | 10分钟超时保护 |
| 多窗口场景下消息错乱 | 低 | 使用 windowId 精确匹配 session |

## 开放问题

1. **Q**: 是否需要在 DEVICE_CONFIRM 页面就开始准备轮询（预热）？
   - **建议**: 否，保持简单，只在 ALLOW_ACCESS 后触发

2. **Q**: 如果用户关闭窗口但未完成授权，如何处理？
   - **现有机制**: windowId 监听已处理此场景

---

**提案状态**: 待审核
**创建时间**: 2026-02-11
**版本**: 1.0
