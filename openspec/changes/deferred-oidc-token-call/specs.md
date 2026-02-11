# 需求规格: 延迟 OIDC Token 调用

## 变更 ID
`deferred-oidc-token-call`

## 需求概述

将 OIDC `/token` 轮询从"获取 device_code 后立即开始"改为"等待用户点击 Allow access 后才开始"。

---

## 功能需求

### REQ-1: 延迟 Token 轮询启动
**描述**: Service Worker 在获取 deviceCode 后不立即开始 Token 轮询，而是等待 `AUTH_COMPLETED` 消息到达后才启动。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S1.1 | 用户开始注册流程 | 观察 Network 面板 | 在 ALLOW_ACCESS 页面点击前，无 `/token` 请求 |
| S1.2 | 用户点击 Allow access | 等待 2 秒 | `/token` 请求开始发送 |

### REQ-2: 会话级状态隔离
**描述**: 每个注册会话的授权等待状态独立，不同窗口的 `AUTH_COMPLETED` 消息不会相互影响。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S2.1 | 并发 2 个注册窗口 | 窗口 A 完成授权 | 仅窗口 A 的 Token 轮询启动 |
| S2.2 | 并发 2 个注册窗口 | 窗口 B 完成授权 | 仅窗口 B 的 Token 轮询启动 |

### REQ-3: 超时保护
**描述**: 等待授权的超时时间应基于 `deviceCode.expiresIn`，默认上限 10 分钟。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S3.1 | 用户未操作 | 等待超过 expiresIn | 会话报错 "等待授权超时" |
| S3.2 | 用户未操作 | 等待 9 分钟后点击授权 | 正常完成 Token 获取 |

### REQ-4: 幂等处理
**描述**: 重复的 `AUTH_COMPLETED` 消息不会导致重复启动 Token 轮询或异常。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S4.1 | 已收到 AUTH_COMPLETED | Content Script 再次发送 | 忽略重复消息，轮询正常 |
| S4.2 | 轮询已完成 | Content Script 发送 AUTH_COMPLETED | 无异常，状态不变 |

### REQ-5: 窗口关闭处理
**描述**: 用户关闭授权窗口时，应立即终止等待并标记会话失败。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S5.1 | 正在等待授权 | 用户关闭窗口 | 会话标记为失败，错误信息 "窗口已关闭" |
| S5.2 | 正在等待授权 | 用户关闭窗口 | 并发 slot 立即释放 |

### REQ-6: 停止注册处理
**描述**: 用户点击"停止"按钮时，所有等待中的授权应立即终止。

**验收场景**:
| 场景 | 前置条件 | 操作 | 预期结果 |
|------|---------|------|---------|
| S6.1 | 2 个窗口等待授权 | 点击停止按钮 | 两个会话都标记为停止 |

---

## 非功能需求

### NFR-1: 消息可靠性
- Content Script 发送 `AUTH_COMPLETED` 后，COMPLETE 页面作为兜底再次发送
- 消息丢失时，依赖超时机制终止等待

### NFR-2: 资源清理
- 所有退出路径（成功、失败、超时、窗口关闭、用户停止）必须清理 timer 和 resolver
- 无 Promise 泄漏、无 timer 泄漏

---

## PBT 属性 (Property-Based Testing)

### PROP-1: 幂等性
**不变式**: 对于任意会话 S，无论收到多少次 `AUTH_COMPLETED` 消息，Token 轮询最多启动一次。
```
∀ session S, ∀ n ∈ ℕ:
  receive(AUTH_COMPLETED, S, n times) → pollStartedCount(S) ≤ 1
```
**反证策略**: 生成随机数量 (1-10) 的重复 AUTH_COMPLETED 消息，验证 pollStartedCount 始终 ≤ 1。

### PROP-2: 会话隔离
**不变式**: 窗口 A 的 `AUTH_COMPLETED` 消息不会触发窗口 B 的 Token 轮询。
```
∀ session A, session B (A ≠ B):
  receive(AUTH_COMPLETED, windowId=A.windowId) →
    ¬triggers(pollSessionToken, B)
```
**反证策略**: 创建 2 个会话，发送针对其中一个的 AUTH_COMPLETED，验证另一个不受影响。

### PROP-3: 超时保证
**不变式**: 等待授权的时间不会超过 `min(expiresIn, 600000)` 毫秒。
```
∀ session S with expiresIn:
  waitDuration(S) ≤ min(S.expiresIn * 1000, 600000)
```
**反证策略**: Mock 时间，验证超时后状态为 error。

### PROP-4: 资源清理完整性
**不变式**: 会话结束后（无论成功或失败），不存在悬挂的 timer 或 unresolved Promise。
```
∀ session S after termination:
  S.authCompletedTimeout === null ∧
  S.authCompletedResolve === null ∧
  S.authCompletedReject === null
```
**反证策略**: 在每种退出路径后检查 session 对象的资源字段。

### PROP-5: 事件顺序无关性
**不变式**: 无论 `AUTH_COMPLETED` 消息是在 `waitForAuthCompleted()` 调用之前还是之后到达，Token 轮询都能正确启动。
```
∀ session S:
  (AUTH_COMPLETED arrives before wait) ∨ (AUTH_COMPLETED arrives during wait)
  → eventually(pollSessionToken(S) starts)
```
**反证策略**: 随机化消息到达时机，验证轮询最终启动。

### PROP-6: 单调性（状态只进不退）
**不变式**: 会话授权状态只会从 `pending` → `completed` 或 `pending` → `timeout/error`，不会回退。
```
∀ session S:
  authState transitions: pending → {completed, timeout, error, cancelled}
  ¬(completed → pending) ∧ ¬(timeout → pending)
```
**反证策略**: 尝试在各种状态下重置 authState，验证无效。

---

## 约束决策记录

| 约束 ID | 决策 | 理由 |
|--------|------|------|
| CD-1 | 超时时间 = min(expiresIn * 1000, 600000) | 避免超过 deviceCode 有效期 |
| CD-2 | 使用会话级 authState 字段缓存状态 | 支持"事件先到"场景 |
| CD-3 | 幂等标志：authCompleted = true 后忽略后续消息 | 防止重复触发 |
| CD-4 | 窗口关闭时 reject Promise 而非仅标记 | 立即释放并发 slot |
| CD-5 | Content Script 无需修改 | 现有 AUTH_COMPLETED 机制已足够 |

---

## 状态: 已确认
## 创建时间: 2026-02-11
## 版本: 1.0
