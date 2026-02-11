# OPSX Proposal: JSON 导出格式优化

## Context

### 用户需求

用户希望优化 JSON 导出功能，具体要求：

1. **文件命名格式**：从当前的 `accounts-YYYY-MM-DD.json` 改为 `yyyyMMddHHmmss+随机数.json`
2. **导出字段调整**：在现有 Token 字段基础上，增加账号元数据字段

### 当前实现

**文件命名** (`popup/popup.js:563`):
```javascript
a.download = `accounts-${new Date().toISOString().slice(0, 10)}.json`;
// 输出示例: accounts-2026-02-11.json
```

**导出格式** (`popup/popup.js:549-554`):
```javascript
const jsonData = validRecords.map(r => ({
  clientId: r.token?.clientId || '',
  clientSecret: r.token?.clientSecret || '',
  accessToken: r.token?.accessToken || '',
  refreshToken: r.token?.refreshToken || ''
}));
```

**Record 结构** (`background/service-worker.js:497-511`):
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  label: session.firstName + ' ' + session.lastName,
  provider: "BuilderId",
  region: "us-east-1",
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null
};
```

---

## Constraint Sets (约束集合)

### 硬约束 (Hard Constraints)

| ID | 约束 | 来源 | 影响 |
|----|------|------|------|
| HC-1 | 必须保持 Token 字段完整性 | 现有导出逻辑 | accessToken, refreshToken, clientId, clientSecret 必须存在 |
| HC-2 | 文件名必须唯一且可排序 | 用户需求 | 使用时间戳 + 随机数确保唯一性 |
| HC-3 | 导出仅包含有效记录 | popup.js:534-541 | 过滤 suspended/expired/invalid/error 状态 |
| HC-4 | 必须兼容现有 record 结构 | service-worker.js:497 | 不能破坏现有数据存储 |
| HC-5 | machineId 字段已存在 | auth-record-logging 变更 | 可直接使用，无需生成 |

### 软约束 (Soft Constraints)

| ID | 约束 | 推荐做法 |
|----|------|----------|
| SC-1 | 文件名格式可读性 | yyyyMMddHHmmss 格式便于排序和识别 |
| SC-2 | 随机数位数 | 6 位数字（100000-999999），用户已确认 |
| SC-3 | 导出字段顺序 | 可灵活调整，用户已确认 |
| SC-4 | 旧记录 machineId | 使用空字符串，用户已确认 |

### 依赖关系 (Dependencies)

```
[用户点击导出] → [exportHistory()]
                      ↓
              [过滤有效记录]
                      ↓
              [转换为新格式]
                      ↓
              [生成文件名: yyyyMMddHHmmss + 随机数]
                      ↓
              [下载 JSON 文件]
```

### 风险 (Risks)

| ID | 风险 | 缓解措施 |
|----|------|----------|
| R-1 | 文件名冲突（同一秒多次导出） | 添加 6 位随机数后缀（冲突概率 < 0.001%） |
| R-2 | machineId 字段缺失（旧记录） | 使用空字符串（已确认） |

---

## Requirements (需求规格)

### R1: 修改文件命名格式

**场景**: 用户点击 JSON 导出按钮

**需求**:
1. 文件名格式从 `accounts-YYYY-MM-DD.json` 改为 `yyyyMMddHHmmss-XXXXXX.json`
2. 时间戳使用当前本地时间（年月日时分秒）
3. 随机数为 6 位数字（100000-999999）

**验证场景**:
```
Given 用户在 2026-02-11 14:30:45 点击导出
When 生成文件名
Then 文件名格式为 "20260211143045-XXXXXX.json"
And XXXXXX 是 6 位随机数字
```

**实现位置**: `popup/popup.js:563`

### R2: 扩展导出字段

**场景**: 导出 JSON 时包含完整账号信息

**需求**:
1. 在现有 Token 字段基础上，添加以下字段：
   - `email`: 账号邮箱
   - `provider`: 固定值 "BuilderId"
   - `region`: 固定值 "us-east-1"
   - `label`: 账号标签（firstName + lastName）
   - `machineId`: 设备唯一标识（从 record 读取，旧记录为空字符串）

2. 导出格式示例（字段顺序可调整）：
   ```json
   {
     "email": "example@gmail.com",
     "provider": "BuilderId",
     "accessToken": "aoaAAAAAGmAXgk0FvlC...",
     "refreshToken": "aorAAAAAGn29ts5LnRrG...",
     "clientId": "Ydce1iQ6srmBT5EYfBlzJ3VzLWVhc3QtMQ",
     "clientSecret": "eyJraWQiOiJrZXktMTU2NDAyODA5OSIsImFsZyI6IkhTMzg0In0...",
     "region": "us-east-1",
     "label": "David Brown",
     "machineId": "05d47a18-e4a9-4001-aca2-f688235609c3"
   }
   ```

**验证场景**:
```
Given 历史记录包含成功注册的账号
When 用户点击 JSON 导出
Then 导出的 JSON 包含所有必需字段
And email 字段非空
And provider 值为 "BuilderId"
And region 值为 "us-east-1"
And machineId 存在（旧记录为空字符串）
```

**实现位置**: `popup/popup.js:549-554`

### R3: 兼容旧记录

**场景**: 导出包含旧版本记录（无 machineId 字段）

**需求**:
1. 如果 record 中不存在 machineId，使用空字符串
2. 如果 record 中不存在 label，使用 `firstName + ' ' + lastName`
3. 确保所有字段都有默认值，避免 undefined

**验证场景**:
```
Given 历史记录包含旧版本记录（无 machineId）
When 用户点击 JSON 导出
Then 导出成功
And machineId 字段为空字符串
And 其他字段正常填充
```

**实现位置**: `popup/popup.js:549-554`

### R4: 复制数据格式与导出一致（新增）

**场景**: 用户点击单条记录的"复制"按钮

**需求**:
1. 复制输出格式从纯文本改为 JSON 格式
2. 复制的 JSON 结构与 `mapRecordToExport()` 输出一致
3. 输出格式化的 JSON（带缩进，便于阅读）

**当前实现** (`popup/popup.js:397-404`):
```javascript
async function copyRecord(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
  const record = response.history?.find(r => String(r.id) === String(id));
  if (record) {
    const text = `邮箱: ${record.email}\n密码: ${record.password}\n姓名: ${record.firstName} ${record.lastName}\nToken: ${record.token?.accessToken || '无'}`;
    await navigator.clipboard.writeText(text);
    alert('已复制到剪贴板');
  }
}
```

**目标实现**:
```javascript
async function copyRecord(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
  const record = response.history?.find(r => String(r.id) === String(id));
  if (record) {
    const exportData = mapRecordToExport(record);
    const jsonStr = JSON.stringify(exportData, null, 2);
    await navigator.clipboard.writeText(jsonStr);
    alert('已复制到剪贴板');
  }
}
```

**验证场景**:
```
Given 历史记录包含成功注册的账号
When 用户点击记录的"复制"按钮
Then 剪贴板内容为格式化的 JSON 字符串
And JSON 结构与批量导出一致
And 包含所有必需字段（email, provider, accessToken, etc.）
```

**实现位置**: `popup/popup.js:397-404`

### R5: 新账号注册时使用 deviceCode 作为 machineId（新增）

**场景**: 用户注册新账号时，自动生成 machineId

**需求**:
1. 在 `saveToHistory()` 中将 `session.oidcAuth.deviceCode` 保存为 `machineId`
2. deviceCode 由 OIDC 设备授权流程生成，格式类似 UUID
3. 确保所有新注册账号都有唯一的 machineId

**当前实现** (`background/service-worker.js:497-511`):
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  label: session.firstName + ' ' + session.lastName,
  provider: "BuilderId",
  region: "us-east-1",
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null
};
```

**目标实现**:
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  label: session.firstName + ' ' + session.lastName,
  provider: "BuilderId",
  region: "us-east-1",
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null,
  machineId: session.oidcAuth?.deviceCode || ''  // 新增
};
```

**验证场景**:
```
Given 用户启动注册流程
When 注册完成并保存到历史
Then 记录包含 machineId 字段
And machineId 值等于 OIDC deviceCode
And 后续导出/复制时 machineId 非空
```

**实现位置**: `background/service-worker.js:497-511`

---

## Success Criteria (成功判据)

| ID | 判据 | 验证方法 |
|----|------|----------|
| SC-1 | 文件名格式正确 | 检查文件名匹配 `\d{14}-\d{6}\.json` |
| SC-2 | 导出包含所有必需字段 | 解析 JSON，验证字段存在 |
| SC-3 | 兼容旧记录 | 导出包含旧记录的历史，machineId 为空字符串 |
| SC-4 | 过滤逻辑不变 | 仅导出 valid/unknown 状态的记录 |
| SC-5 | CSV 导出不受影响 | CSV 导出功能正常工作 |
| SC-6 | 复制格式为 JSON | 点击复制按钮，剪贴板内容可解析为有效 JSON |
| SC-7 | 复制与导出字段一致 | 复制的 JSON 包含与导出相同的字段结构 |
| SC-8 | 新账号 machineId 非空 | 新注册账号导出/复制时 machineId 等于 deviceCode |

---

## Implementation Files (涉及文件)

| 文件 | 操作 | 说明 |
|------|------|------|
| `popup/popup.js` | 修改 | exportHistory() 函数：修改文件名生成和导出格式；copyRecord() 函数：改为 JSON 格式 |
| `background/service-worker.js` | 修改 | saveToHistory()：添加 machineId 字段 |

---

## Implementation Details (实现细节)

### 修改 exportHistory() (popup/popup.js)

```javascript
async function exportHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
    const history = response.history || [];

    if (history.length === 0) {
      alert('暂无记录');
      return;
    }

    // 过滤有效记录（保持不变）
    const validRecords = history.filter(r =>
      r.success &&
      r.token &&
      r.tokenStatus !== 'suspended' &&
      r.tokenStatus !== 'expired' &&
      r.tokenStatus !== 'invalid' &&
      r.tokenStatus !== 'error'
    );

    if (validRecords.length === 0) {
      alert('没有有效的注册记录（可能全部被封禁、过期或无效）');
      return;
    }

    // 生成新的 JSON 格式
    const jsonData = validRecords.map(r => ({
      email: r.email || '',
      provider: r.provider || 'BuilderId',
      accessToken: r.token?.accessToken || '',
      refreshToken: r.token?.refreshToken || '',
      clientId: r.token?.clientId || '',
      clientSecret: r.token?.clientSecret || '',
      region: r.region || 'us-east-1',
      label: r.label || `${r.firstName || ''} ${r.lastName || ''}`.trim(),
      machineId: r.machineId || ''
    }));

    const jsonStr = JSON.stringify(jsonData, null, 2);

    // 生成新的文件名: yyyyMMddHHmmss-XXXXXX.json
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0')
    ].join('');
    const randomSuffix = String(Math.floor(Math.random() * 900000) + 100000); // 6位随机数
    const filename = `${timestamp}-${randomSuffix}.json`;

    // 下载 JSON
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // 提示导出数量（保持不变）
    const totalSuccess = history.filter(r => r.success && r.token).length;
    if (validRecords.length < totalSuccess) {
      alert(`已导出 ${validRecords.length} 个有效账号（共 ${totalSuccess} 个成功注册，${totalSuccess - validRecords.length} 个被过滤）`);
    }

  } catch (error) {
    console.error('[Popup] 导出错误:', error);
  }
}
```

### 注意事项

1. **字段顺序**: 可灵活调整，不影响功能
2. **兼容性**: 无需异步操作，实现简单
3. **降级方案**: 所有字段都有默认值（空字符串）

---

## User Confirmations (用户确认)

以下问题已由用户确认：

### 第一轮确认（需求研究阶段）

1. **clientIdHash 字段**: ✅ **可以省略此字段**
   - 不计算 SHA-256 哈希，减少计算开销
   - 简化实现，提升导出速度

2. **machineId 处理**: ✅ **旧记录使用空字符串**
   - 旧记录（无 machineId）导出时使用空字符串
   - 不生成新的 UUID，保持数据真实性

3. **字段顺序**: ✅ **可以调整顺序**
   - 不需要严格按照示例顺序
   - 只要包含所有必需字段即可

4. **随机数位数**: ✅ **6 位数字（100000-999999）**
   - 平衡唯一性和文件名长度
   - 同一秒内冲突概率 < 0.001%

### 第二轮确认（实施计划阶段）

5. **时区策略**: ✅ **本地时间**
   - 文件名时间与用户操作时间一致
   - 便于用户识别和归档

6. **随机数生成**: ✅ **Math.random()**
   - 简单实现，无需降级处理
   - 配合序列号机制，冲突概率可接受

7. **冲突处理**: ✅ **添加序列号**
   - 维护 lastSecond 和 seq
   - 同秒内递增，进程内零冲突
   - 文件名格式：`yyyyMMddHHmmss-XXXXXX-seq`（seq > 0 时）

8. **代码重构**: ✅ **提取辅助函数**
   - 提取 `generateFilename()` 和 `mapRecordToExport()`
   - 提升可维护性和可测试性

### 第三轮确认（增量需求研究）

9. **复制格式**: ✅ **使用 JSON 格式**
   - 与导出格式完全一致
   - 复用 `mapRecordToExport()` 函数

10. **新账号 machineId**: ✅ **使用 OIDC deviceCode**
    - 在 `saveToHistory()` 时保存 `session.oidcAuth?.deviceCode` 作为 machineId
    - 确保新注册账号都有唯一标识

---

## Property-Based Testing (PBT) Properties

### 核心不变量 (Invariants)

**INV-1: 文件名唯一性**
```
属性: 同一会话内，连续导出的文件名必须唯一
定义: ∀ export1, export2 ∈ session: export1.filename ≠ export2.filename
边界: 同秒内多次导出（最多 1000 次/秒）
反例: 快速连续调用 exportHistory()，检查文件名集合无重复
```

**INV-2: 文件名格式正确性**
```
属性: 文件名必须匹配正则 ^\d{14}-\d{6}(-\d+)?\.json$
定义: filename.match(/^\d{14}-\d{6}(-\d+)?\.json$/)
边界: 跨午夜、跨月、跨年导出
反例: 生成随机时间戳，验证格式化结果
```

**INV-3: 时间戳单调性**
```
属性: 文件名时间戳应单调递增（允许相等）
定义: ∀ i < j: timestamp(export[i]) ≤ timestamp(export[j])
边界: 系统时钟回拨
反例: 模拟时钟回拨，验证序列号递增
```

**INV-4: 导出字段完整性**
```
属性: 每条导出记录必须包含所有必需字段
定义: ∀ record: hasFields(record, ['email', 'provider', 'accessToken',
       'refreshToken', 'clientId', 'clientSecret', 'region', 'label', 'machineId'])
边界: 旧记录（缺失 machineId）、失败记录（无 token）
反例: 构造各种不完整的 record，验证默认值填充
```

**INV-5: 过滤逻辑一致性**
```
属性: 仅导出 success=true 且 tokenStatus ∈ {valid, unknown} 的记录
定义: ∀ exported: exported.success &&
       exported.tokenStatus ∉ {suspended, expired, invalid, error}
边界: tokenStatus 为 null/undefined
反例: 构造各种 tokenStatus 组合，验证过滤结果
```

**INV-6: 复制与导出一致性**（新增）
```
属性: copyRecord 的输出必须可解析为与导出格式相同的 JSON 结构
定义: JSON.parse(copyRecord(id)).keys === mapRecordToExport(record).keys
边界: 包含特殊字符的记录、token 为空的记录
反例: 复制任意记录，验证 JSON 结构与导出一致
```

**INV-7: machineId 来源一致性**（新增）
```
属性: 新注册账号的 machineId 必须等于 OIDC deviceCode
定义: ∀ new_record: record.machineId === session.oidcAuth.deviceCode
边界: deviceCode 为空/undefined
反例: 注册新账号，验证 machineId 与 deviceCode 相等
```

### 幂等性属性 (Idempotency)

**IDEM-1: 字段映射幂等**
```
属性: 对同一 record 多次调用 mapRecordToExport() 返回相同结果
定义: mapRecordToExport(r) === mapRecordToExport(r)
反例: 随机 record，多次映射，比较结果
```

### 往返属性 (Round-trip)

**RT-1: JSON 序列化往返**
```
属性: JSON.parse(JSON.stringify(data)) 应等价于 data
定义: deepEqual(JSON.parse(JSON.stringify(data)), data)
边界: 特殊字符、Unicode、大数值
反例: 构造包含特殊字符的 record，验证序列化
```

### 边界属性 (Bounds)

**BOUND-1: 随机数范围**
```
属性: 随机后缀必须在 [100000, 999999] 范围内
定义: 100000 ≤ randomSuffix ≤ 999999
反例: 生成 10000 个随机数，验证范围
```

**BOUND-2: 序列号范围**
```
属性: 同秒序列号从 0 开始递增，无上限
定义: seq ≥ 0 && seq === previousSeq + 1
反例: 同秒内连续导出 100 次，验证序列号
```

---

## Implementation Plan (实施计划)

### 零决策实施步骤

**步骤 1: 已完成** - generateFilename() 和 mapRecordToExport() 辅助函数已添加

**步骤 2: 已完成** - exportHistory() 函数已更新

**步骤 3: 修改 copyRecord() 函数**（新增）

位置: `popup/popup.js:397-405`

当前代码：
```javascript
async function copyRecord(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
  const record = response.history?.find(r => String(r.id) === String(id));
  if (record) {
    const text = `邮箱: ${record.email}\n密码: ${record.password}\n姓名: ${record.firstName} ${record.lastName}\nToken: ${record.token?.accessToken || '无'}`;
    await navigator.clipboard.writeText(text);
    alert('已复制到剪贴板');
  }
}
```

目标代码：
```javascript
/**
 * 复制记录（JSON 格式）
 */
async function copyRecord(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
  const record = response.history?.find(r => String(r.id) === String(id));
  if (record) {
    const exportData = mapRecordToExport(record);
    const jsonStr = JSON.stringify(exportData, null, 2);
    await navigator.clipboard.writeText(jsonStr);
    alert('已复制到剪贴板');
  }
}
```

**步骤 4: 修改 saveToHistory() 函数**（新增）

位置: `background/service-worker.js:497-511`

当前代码：
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  label: session.firstName + ' ' + session.lastName,
  provider: "BuilderId",
  region: "us-east-1",
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null
};
```

目标代码：
```javascript
const record = {
  id: Date.now() + Math.random(),
  time: new Date().toLocaleString(),
  email: session.email,
  password: session.password,
  label: session.firstName + ' ' + session.lastName,
  provider: "BuilderId",
  region: "us-east-1",
  firstName: session.firstName,
  lastName: session.lastName,
  success: success,
  error: success ? null : session.error,
  token: tokenInfo,
  tokenStatus: success ? 'unknown' : null,
  machineId: session.oidcAuth?.deviceCode || ''
};
```

**步骤 5: 验证**

1. 测试复制功能：
   - 点击复制按钮，验证剪贴板内容是有效 JSON
   - 比较复制的 JSON 与导出的字段结构一致
   - 测试包含特殊字符的记录

2. 测试 machineId 生成：
   - 注册新账号，验证 machineId 非空
   - 验证 machineId 与 OIDC deviceCode 一致
   - 导出/复制时验证 machineId 字段正确

3. 回归测试：
   - 旧记录的 machineId 仍为空字符串
   - CSV 导出功能不受影响
   - 文件名格式仍正确

---

## Next Steps

1. 用户审查并批准实施计划
2. 运行 `/ccg:spec-impl` 开始实现
3. 实施后运行单元测试验证 PBT 属性

---

*Created by CCG:SPEC:RESEARCH at 2026-02-11*
*Updated at 2026-02-11: 添加 R4/R5 需求（复制 JSON 格式 + machineId 使用 deviceCode）*
