# 实施任务清单: 延迟 OIDC Token 调用

## 变更 ID
`deferred-oidc-token-call`

## 任务概览

| # | 任务 | 文件 | 预计改动行数 | 依赖 |
|---|------|------|-------------|------|
| T1 | 扩展 Session 数据结构 | service-worker.js | ~10 | - |
| T2 | 实现授权等待函数组 | service-worker.js | ~50 | T1 |
| T3 | 修改注册流程 | service-worker.js | ~15 | T2 |
| T4 | 修改消息处理器 | service-worker.js | ~10 | T2 |
| T5 | 扩展停止和清理逻辑 | service-worker.js | ~15 | T2 |
| T6 | 手动测试验证 | - | - | T1-T5 |

---

## T1: 扩展 Session 数据结构

### 目标
在 `createSession()` 函数中添加授权等待相关字段

### 修改位置
`background/service-worker.js:151-179` (createSession 函数)

### 具体改动
在 session 对象中添加:
```javascript
// 授权等待状态
authState: 'pending',        // 'pending' | 'completed' | 'timeout' | 'cancelled'
authCompletedResolve: null,  // Promise resolver
authCompletedReject: null,   // Promise rejecter
authCompletedTimeout: null,  // setTimeout ID
```

### 验收标准
- [x] 新创建的 session 包含 authState = 'pending'
- [x] 其他三个字段初始化为 null

---

## T2: 实现授权等待函数组

### 目标
添加 4 个函数处理授权等待逻辑

### 修改位置
`background/service-worker.js` - 在 `withApiLock` 函数之后添加新的函数块

### 函数 2.1: waitForAuthCompleted(session)
```javascript
/**
 * 等待授权完成信号
 * @param {Object} session
 * @returns {Promise<void>}
 */
function waitForAuthCompleted(session) {
  // 事件先到检查
  if (session.authState === 'completed') {
    return Promise.resolve();
  }

  // 计算超时: min(expiresIn * 1000, 600000)
  const expiresIn = session.oidcAuth?.expiresIn || 600;
  const timeout = Math.min(expiresIn * 1000, 600000);

  return new Promise((resolve, reject) => {
    session.authCompletedResolve = resolve;
    session.authCompletedReject = reject;

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

### 函数 2.2: resolveAuthCompleted(session)
```javascript
/**
 * 触发授权完成（幂等）
 * @param {Object} session
 */
function resolveAuthCompleted(session) {
  if (!session || session.authState !== 'pending') {
    return; // 幂等
  }

  session.authState = 'completed';

  if (session.authCompletedResolve) {
    session.authCompletedResolve();
  }

  cleanupAuthWait(session);
}
```

### 函数 2.3: cancelAuthWait(session, reason)
```javascript
/**
 * 取消授权等待
 * @param {Object} session
 * @param {string} reason
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

### 函数 2.4: cleanupAuthWait(session)
```javascript
/**
 * 清理授权等待资源
 * @param {Object} session
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

### 验收标准
- [x] 4 个函数无语法错误
- [x] waitForAuthCompleted 支持事件先到
- [x] resolveAuthCompleted 具有幂等性
- [x] cleanupAuthWait 清理所有资源

---

## T3: 修改注册流程

### 目标
在 `runSessionRegistration()` 中插入授权等待步骤

### 修改位置
`background/service-worker.js:389-394` (步骤 5 和步骤 6 之间)

### 具体改动

**在步骤 5 (验证码轮询启动) 之后，步骤 6 (Token 轮询) 之前插入:**

```javascript
    // === 步骤 5.5: 等待授权完成 ===
    session.status = 'waiting_auth';
    updateSession(session.id, { step: '等待用户授权...' });

    await waitForAuthCompleted(session);

    // 检查是否被停止
    if (shouldStop || session.pollAbort) {
      throw new Error('注册已停止');
    }
```

**在 finally 块中添加清理:**
```javascript
  } finally {
    // 清理授权等待资源
    cleanupAuthWait(session);

    // ... 现有清理逻辑 ...
  }
```

### 验收标准
- [x] 步骤 5.5 在步骤 5 和 6 之间执行
- [x] 状态正确更新为 'waiting_auth'
- [x] finally 中调用 cleanupAuthWait

---

## T4: 修改消息处理器

### 目标
修改 `AUTH_COMPLETED` 消息处理，触发授权完成

### 修改位置
`background/service-worker.js:973-978` (AUTH_COMPLETED case)

### 具体改动

**替换现有代码:**
```javascript
    case 'AUTH_COMPLETED':
      if (session) {
        resolveAuthCompleted(session);
        updateSession(session.id, { step: '授权完成，开始获取 Token...' });
      }
      sendResponse({ success: true });
      break;
```

### 验收标准
- [x] 收到 AUTH_COMPLETED 时调用 resolveAuthCompleted
- [x] 步骤文本正确更新

---

## T5: 扩展停止和清理逻辑

### 目标
确保所有退出路径都正确取消/清理授权等待

### 修改位置 5.1: stopRegistration()
`background/service-worker.js:781-793`

**添加取消授权等待:**
```javascript
function stopRegistration() {
  console.log('[Service Worker] 停止注册');
  shouldStop = true;
  taskQueue = [];

  for (const session of sessions.values()) {
    session.pollAbort = true;
    cancelAuthWait(session, '用户停止注册');  // 新增
  }

  updateGlobalState({ step: '正在停止...' });
}
```

### 修改位置 5.2: windows.onRemoved
`background/service-worker.js:1036-1043`

**添加取消授权等待:**
```javascript
chrome.windows.onRemoved.addListener((windowId) => {
  const session = findSessionByWindowId(windowId);
  if (session) {
    console.log(`[Service Worker] 会话 ${session.id} 的窗口已关闭`);
    cancelAuthWait(session, '授权窗口已关闭');  // 新增
    session.windowId = null;
    session.tabId = null;
  }
});
```

### 修改位置 5.3: destroySession()
`background/service-worker.js:184-204`

**添加清理授权等待:**
```javascript
async function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // 清理授权等待
  cleanupAuthWait(session);  // 新增

  // ... 现有清理逻辑 ...
}
```

### 验收标准
- [x] stopRegistration 取消所有等待中的授权
- [x] 窗口关闭时取消对应会话的授权等待
- [x] destroySession 清理授权等待资源

---

## T6: 手动测试验证

### 测试场景清单

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|---------|
| T6.1 | 正常流程 | 启动注册 → 观察 Network → 点击 Allow | 点击前无 /token，点击后开始轮询 |
| T6.2 | 并发隔离 | 并发 2 窗口 → 窗口 A 授权 | 仅 A 开始轮询 |
| T6.3 | 窗口关闭 | 等待授权时关闭窗口 | 会话标记失败，无泄漏 |
| T6.4 | 用户停止 | 等待授权时点击停止 | 所有会话终止 |
| T6.5 | 超时 | 等待超过 10 分钟 | 会话报错 "等待授权超时" |
| T6.6 | 完整流程 | 执行 3 次并发注册 | 全部成功，无异常 |

### 验收标准
- [ ] 所有 6 个测试场景通过
- [ ] Console 无未捕获异常
- [ ] 内存使用正常（无明显泄漏）

---

## 回滚计划

如需回滚:
1. 删除 4 个新增函数
2. 移除 createSession 中的新字段
3. 移除 runSessionRegistration 中的步骤 5.5
4. 恢复 AUTH_COMPLETED handler 原始逻辑
5. 移除 stopRegistration/onRemoved/destroySession 中的新增调用

---

## 状态: 代码完成，待测试
## 创建时间: 2026-02-11
## 版本: 1.0
