# 技术设计: 延迟 OIDC Token 调用

## 变更 ID
`deferred-oidc-token-call`

## 架构决策

### 方案选择: 事件驱动 + 会话状态缓存

**选择理由**:
1. 复用现有 `AUTH_COMPLETED` 消息机制
2. 改动集中在 Service Worker，Content Script 无需修改
3. 支持"事件先到"场景（AUTH_COMPLETED 在 wait 之前到达）
4. 自然支持幂等和会话隔离

### 替代方案对比

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| Promise 等待 | 实现简单 | 需要精细清理，难处理事件先到 | 基础可用 |
| 状态机 | 边界覆盖完整 | 实现成本高 | 未来升级方向 |
| webNavigation 监听 | 不依赖 Content Script | 需要额外权限，URL 检测不精确 | 不采用 |

**最终决策**: 采用 "Promise 等待 + 会话状态缓存" 混合模式

---

## 数据结构设计

### Session 对象扩展

```javascript
// background/service-worker.js
function createSession() {
  return {
    // ... 现有字段 ...

    // 新增: 授权等待状态
    authState: 'pending',        // 'pending' | 'completed' | 'timeout' | 'cancelled'
    authCompletedResolve: null,  // Promise resolver
    authCompletedReject: null,   // Promise rejecter
    authCompletedTimeout: null,  // setTimeout ID
    authWaitStartTime: null,     // 等待开始时间（用于日志）
  };
}
```

### 状态转换图

```
┌─────────┐                              ┌───────────┐
│ pending │ ──── AUTH_COMPLETED ────────▶│ completed │
└────┬────┘                              └───────────┘
     │
     │ timeout / window closed / stop
     ▼
┌──────────────┐
│ timeout/     │
│ cancelled/   │
│ error        │
└──────────────┘
```

---

## 函数设计

### 1. waitForAuthCompleted(session)

**职责**: 等待授权完成信号，返回 Promise

```javascript
/**
 * 等待授权完成信号
 * @param {Object} session - 会话对象
 * @returns {Promise<void>} - 授权完成时 resolve，超时/取消时 reject
 *
 * 边界条件:
 * - 如果 authState 已经是 'completed'，立即返回（事件先到场景）
 * - 超时时间 = min(session.oidcAuth.expiresIn * 1000, 600000)
 * - 支持通过 cancelAuthWait(session) 取消
 */
function waitForAuthCompleted(session) {
  // 1. 检查是否已完成（事件先到）
  if (session.authState === 'completed') {
    return Promise.resolve();
  }

  // 2. 计算超时时间
  const expiresIn = session.oidcAuth?.expiresIn || 600;
  const timeout = Math.min(expiresIn * 1000, 600000);

  // 3. 创建 Promise
  return new Promise((resolve, reject) => {
    session.authCompletedResolve = resolve;
    session.authCompletedReject = reject;
    session.authWaitStartTime = Date.now();

    // 4. 设置超时
    session.authCompletedTimeout = setTimeout(() => {
      if (session.authState === 'pending') {
        session.authState = 'timeout';
        cleanupAuthWait(session);
        reject(new Error('等待授权超时'));
      }
    }, timeout);
  });
}
```

### 2. resolveAuthCompleted(session)

**职责**: 处理 AUTH_COMPLETED 消息，触发等待的 Promise

```javascript
/**
 * 触发授权完成
 * @param {Object} session - 会话对象
 *
 * 幂等性: 多次调用只生效一次
 */
function resolveAuthCompleted(session) {
  if (!session || session.authState !== 'pending') {
    // 幂等: 已处理过，忽略
    return;
  }

  session.authState = 'completed';

  // 如果有等待者，resolve 它
  if (session.authCompletedResolve) {
    session.authCompletedResolve();
  }

  cleanupAuthWait(session);
}
```

### 3. cancelAuthWait(session, reason)

**职责**: 取消等待（窗口关闭、用户停止等）

```javascript
/**
 * 取消授权等待
 * @param {Object} session - 会话对象
 * @param {string} reason - 取消原因
 */
function cancelAuthWait(session, reason = '授权被取消') {
  if (!session || session.authState !== 'pending') {
    return;
  }

  session.authState = 'cancelled';

  if (session.authCompletedReject) {
    session.authCompletedReject(new Error(reason));
  }

  cleanupAuthWait(session);
}
```

### 4. cleanupAuthWait(session)

**职责**: 清理资源（timer、resolver）

```javascript
/**
 * 清理授权等待相关资源
 * @param {Object} session - 会话对象
 */
function cleanupAuthWait(session) {
  if (session.authCompletedTimeout) {
    clearTimeout(session.authCompletedTimeout);
    session.authCompletedTimeout = null;
  }
  session.authCompletedResolve = null;
  session.authCompletedReject = null;
}
```

---

## 修改点清单

### 文件: background/service-worker.js

| 位置 | 修改类型 | 说明 |
|------|---------|------|
| createSession() | 扩展 | 添加 authState, authCompletedResolve 等字段 |
| 新增函数 | 添加 | waitForAuthCompleted, resolveAuthCompleted, cancelAuthWait, cleanupAuthWait |
| runSessionRegistration() | 修改 | 步骤 6 之前插入 await waitForAuthCompleted(session) |
| AUTH_COMPLETED handler | 修改 | 调用 resolveAuthCompleted(session) |
| stopRegistration() | 扩展 | 遍历会话调用 cancelAuthWait |
| windows.onRemoved listener | 扩展 | 调用 cancelAuthWait(session, '窗口已关闭') |
| destroySession() | 扩展 | 调用 cleanupAuthWait |

### 文件: content/content.js

**无修改** - 现有 AUTH_COMPLETED 机制已满足需求

### 文件: lib/oidc-api.js

**无修改** - Token 轮询逻辑保持不变

---

## 关键代码片段

### runSessionRegistration 修改

```javascript
async function runSessionRegistration(session) {
  try {
    // ... 步骤 1-5 不变 ...

    // === 新增: 步骤 5.5 - 等待授权完成 ===
    session.status = 'waiting_auth';
    updateSession(session.id, { step: '等待用户授权...' });

    try {
      await waitForAuthCompleted(session);
    } catch (authError) {
      // 超时或取消
      throw authError;
    }

    // 步骤 6: 轮询 Token（原有逻辑）
    session.status = 'polling_token';
    updateSession(session.id, { step: '获取 Token...' });

    const tokenResult = await pollSessionToken(session);
    // ... 后续不变 ...
  } catch (error) {
    // ... 错误处理不变 ...
  } finally {
    // === 新增: 确保清理 ===
    cleanupAuthWait(session);
    // ... 其他清理不变 ...
  }
}
```

### AUTH_COMPLETED 消息处理修改

```javascript
case 'AUTH_COMPLETED':
  if (session) {
    resolveAuthCompleted(session);
    updateSession(session.id, { step: '授权完成，开始获取 Token...' });
  }
  sendResponse({ success: true });
  break;
```

### stopRegistration 扩展

```javascript
function stopRegistration() {
  console.log('[Service Worker] 停止注册');
  shouldStop = true;
  taskQueue = [];

  for (const session of sessions.values()) {
    session.pollAbort = true;
    // === 新增 ===
    cancelAuthWait(session, '用户停止注册');
  }

  updateGlobalState({ step: '正在停止...' });
}
```

### windows.onRemoved 扩展

```javascript
chrome.windows.onRemoved.addListener((windowId) => {
  const session = findSessionByWindowId(windowId);
  if (session) {
    console.log(`[Service Worker] 会话 ${session.id} 的窗口已关闭`);
    // === 新增 ===
    cancelAuthWait(session, '授权窗口已关闭');
    session.windowId = null;
    session.tabId = null;
  }
});
```

---

## 风险缓解措施

| 风险 | 缓解措施 | 实现位置 |
|------|---------|---------|
| 消息丢失 | COMPLETE 页面兜底发送 AUTH_COMPLETED | content.js (现有) |
| Promise 泄漏 | cleanupAuthWait 在所有退出路径调用 | finally 块 + 事件监听 |
| 事件先到 | authState 缓存状态，wait 前检查 | waitForAuthCompleted |
| 重复消息 | authState 幂等检查 | resolveAuthCompleted |
| 超时过长 | 使用 min(expiresIn, 600s) | waitForAuthCompleted |

---

## 状态: 已确认
## 创建时间: 2026-02-11
## 版本: 1.0
