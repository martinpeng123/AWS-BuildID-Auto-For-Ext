# OPSX Proposal: 授权登录信息记录

## Context

### 用户需求
在 `lib/oidc-api.js` 授权登录成功时，将以下信息记录到文件中：
- machineId
- email
- provider="BuilderId"
- region
- label

### 现有存储逻辑

当前 `saveToHistory()` 函数 (`background/service-worker.js:487`) 已记录：
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null
};
```

存储方式：`chrome.storage.local.set({ registrationHistory })`

---

## Constraint Sets (约束集合)

### 硬约束 (Hard Constraints)

| ID | 约束 | 来源 | 影响 |
|----|------|------|------|
| HC-1 | provider 固定为 "BuilderId" | popup.js:344 | 无需用户输入 |
| HC-2 | region 固定为 "us-east-1" | oidc-api.js:7, popup.js:345 | 无需用户输入 |
| HC-3 | 使用 chrome.storage.local | 现有架构 | 复用现有存储机制 |
| HC-4 | 历史记录限制 100 条 | service-worker.js:513 | 保持现有限制 |

### 软约束 (Soft Constraints)

| ID | 约束 | 推荐做法 |
|----|------|----------|
| SC-1 | machineId 来源 | 使用 generateUUID() 自动生成 |
| SC-2 | label 用途 | 使用 firstName + lastName 作为标签 |
| SC-3 | 导出格式兼容 | CSV/JSON 导出包含新字段 |

### 依赖关系 (Dependencies)

```
[授权登录成功] → [saveToHistory()] → [chrome.storage.local]
                      ↓
              [添加新字段: machineId, provider, region, label]
```

---

## Requirements (需求规格)

### R1: 扩展历史记录字段

**场景**: 授权登录成功后保存完整信息

**需求**:
1. 修改 `saveToHistory()` 函数，在 record 对象中添加：
   - `machineId`: 使用 `generateUUID()` 生成唯一标识
   - `provider`: 固定值 `"BuilderId"`
   - `region`: 固定值 `"us-east-1"`
   - `label`: 自动生成，格式 `"{email前缀}_{时间戳}"`

**验证场景**:
```
Given 用户完成授权登录
When saveToHistory() 被调用
Then 记录包含 machineId, provider, region, label 字段
And machineId 是有效的 UUID 格式
```

### R2: 导出功能适配

**场景**: 导出历史记录时包含新字段

**需求**:
1. CSV 导出添加新列：machineId, provider, region, label
2. JSON 导出保持原格式（仅 Token 信息），新增可选的完整导出

**验证场景**:
```
Given 历史记录包含新字段
When 用户点击"导出 CSV"
Then CSV 文件包含 machineId, provider, region, label 列
```

---

## Success Criteria (成功判据)

| ID | 判据 | 验证方法 |
|----|------|----------|
| SC-1 | 新记录包含 machineId | 检查 chrome.storage.local |
| SC-2 | machineId 格式为 UUID | 正则验证 |
| SC-3 | provider 值为 "BuilderId" | 直接检查 |
| SC-4 | region 值为 "us-east-1" | 直接检查 |
| SC-5 | CSV 导出包含新字段 | 下载并检查 CSV |
| SC-6 | 现有功能不受影响 | 回归测试 |

---

## Implementation Files (涉及文件)

| 文件 | 操作 | 说明 |
|------|------|------|
| `background/service-worker.js` | 修改 | 扩展 saveToHistory() 添加新字段 |
| `popup/popup.js` | 修改 | exportHistoryCSV() 添加新列 |
| `lib/utils.js` | 无修改 | 复用现有 generateUUID() |

---

## Implementation Details (实现细节)

### 修改 saveToHistory() (service-worker.js)

```javascript
function saveToHistory(session, success) {
  let tokenInfo = null;
  if (success && session.token) {
    tokenInfo = {
      ...session.token,
      clientId: session.oidcAuth?.clientId || '',
      clientSecret: session.oidcAuth?.clientSecret || ''
    };
  }

  // 生成 machineId 和 label
  const machineId = generateUUID();
  const label = `${session.firstName || ''}${session.lastName || ''}`;

  const record = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleString(),
    email: session.email,
    password: session.password,
    firstName: session.firstName,
    lastName: session.lastName,
    success: success,
    error: success ? null : session.error,
    token: tokenInfo,
    tokenStatus: success ? 'unknown' : null,
    // 新增字段
    machineId: machineId,
    provider: 'BuilderId',
    region: 'us-east-1',
    label: label
  };

  registrationHistory.unshift(record);
  // ...
}
```

### 修改 exportHistoryCSV() (popup.js)

```javascript
// 添加新列
const headers = [
  'email', 'password', 'first_name', 'last_name',
  'client_id', 'client_secret', 'access_token', 'refresh_token',
  'success', 'token_status', 'error',
  'machine_id', 'provider', 'region', 'label'  // 新增
];

const rows = history.map(r => [
  // ... 现有字段
  r.machineId || '',
  r.provider || '',
  r.region || '',
  r.label || ''
]);
```

---

## Next Steps

1. 运行 `/ccg:spec-plan` 生成详细执行计划
2. 或直接运行 `/ccg:spec-impl` 开始实现

---

*Created by CCG:SPEC:RESEARCH at 2026-02-10*
