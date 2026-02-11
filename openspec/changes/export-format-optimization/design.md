# Design Document: JSON 导出格式优化

## 技术决策

### TD-1: 文件命名算法

**决策**: 使用 `yyyyMMddHHmmss-XXXXXX[-seq].json` 格式

**理由**:
- 时间戳部分（14位）：自然排序，跨平台兼容
- 随机后缀（6位）：降低冲突概率
- 序列号（可选）：同秒内零冲突

**实现细节**:
```javascript
// 时间戳：本地时间，零填充
const timestamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0')
].join('');

// 随机后缀：Math.random() 生成 6 位数字
const randomSuffix = String(Math.floor(Math.random() * 900000) + 100000);

// 序列号：同秒递增
const seqSuffix = exportSeq > 0 ? `-${exportSeq}` : '';
```

**权衡**:
- ✅ 简单实现，无需外部依赖
- ✅ 本地时间与用户操作时间一致
- ⚠️ Math.random() 可预测（但配合序列号，冲突概率可接受）

---

### TD-2: 时区策略

**决策**: 使用本地时间（getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds）

**理由**:
- 文件名时间与用户操作时间一致
- 便于用户识别和归档
- 无需时区转换，实现简单

**替代方案**:
- UTC 时间：跨地区一致性更好，但文件名时间与用户本地时间不一致

---

### TD-3: 随机数生成策略

**决策**: 使用 `Math.random()` 生成 6 位随机数

**理由**:
- 简单实现，无需降级处理
- 配合序列号机制，冲突概率可接受
- 浏览器兼容性好

**替代方案**:
- `crypto.getRandomValues()`：更安全，但需要降级处理（用户选择不使用）

---

### TD-4: 冲突处理机制

**决策**: 维护 `lastExportSecond` 和 `exportSeq`，同秒内递增

**实现**:
```javascript
let lastExportSecond = 0;
let exportSeq = 0;

function generateFilename() {
  const currentSecond = Math.floor(now.getTime() / 1000);
  if (currentSecond === lastExportSecond) {
    exportSeq++;
  } else {
    lastExportSecond = currentSecond;
    exportSeq = 0;
  }
  // ...
}
```

**保证**:
- 同一会话内，文件名唯一性 100%
- 跨会话/跨设备，冲突概率 < 0.001%（6位随机数）

---

### TD-5: 代码结构

**决策**: 提取辅助函数 `generateFilename()` 和 `mapRecordToExport()`

**理由**:
- 提升可维护性：单一职责原则
- 提升可测试性：独立测试文件名生成和字段映射
- 提升可读性：exportHistory() 函数更简洁

**函数签名**:
```javascript
function generateFilename(): string
function mapRecordToExport(record: Object): Object
```

---

### TD-6: 导出字段映射

**决策**: 固定字段顺序（可调整），所有字段使用默认值兜底

**字段列表**:
1. `email`: record.email || ''
2. `provider`: record.provider || 'BuilderId'
3. `accessToken`: record.token?.accessToken || ''
4. `refreshToken`: record.token?.refreshToken || ''
5. `clientId`: record.token?.clientId || ''
6. `clientSecret`: record.token?.clientSecret || ''
7. `region`: record.region || 'us-east-1'
8. `label`: record.label || `${firstName} ${lastName}`.trim()
9. `machineId`: record.machineId || ''

**兜底策略**:
- 所有字段使用空字符串或固定值兜底
- 避免 undefined/null 导致 JSON 序列化异常

---

### TD-7: 错误处理

**决策**: 在 exportHistory() 函数中添加 try-catch，捕获所有异常

**处理方式**:
```javascript
try {
  // 导出逻辑
} catch (error) {
  console.error('[Popup] 导出错误:', error);
  alert('导出失败: ' + error.message);
}
```

**覆盖场景**:
- chrome.runtime.sendMessage 失败
- JSON.stringify 失败
- Blob 创建失败
- URL.createObjectURL 失败

---

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     exportHistory()                         │
│  (主函数，协调导出流程)                                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ├─────────────────────────────────┐
                          │                                 │
                          ▼                                 ▼
          ┌───────────────────────────┐   ┌─────────────────────────────┐
          │  generateFilename()       │   │  mapRecordToExport()        │
          │  (生成唯一文件名)          │   │  (字段映射 + 默认值)         │
          └───────────────────────────┘   └─────────────────────────────┘
                          │                                 │
                          │                                 │
                          ▼                                 ▼
          ┌───────────────────────────┐   ┌─────────────────────────────┐
          │  时间戳格式化              │   │  字段提取 + 兜底             │
          │  随机数生成                │   │  (email, provider, ...)     │
          │  序列号递增                │   └─────────────────────────────┘
          └───────────────────────────┘
                          │
                          ▼
          ┌───────────────────────────┐
          │  文件名字符串              │
          │  yyyyMMddHHmmss-XXXXXX    │
          │  [-seq].json              │
          └───────────────────────────┘
```

---

## 性能考虑

### 时间复杂度

- `generateFilename()`: O(1)
- `mapRecordToExport()`: O(1)
- `exportHistory()`: O(n)，n = validRecords.length

### 空间复杂度

- 文件名生成：O(1)
- 字段映射：O(1)
- JSON 序列化：O(n)，n = 导出记录总大小

### 优化建议

1. **避免重复格式化**：在一次导出中只生成一次文件名
2. **减少字符串拼接**：使用数组 join() 替代 + 操作符
3. **延迟 Blob 创建**：仅在需要时创建 Blob

---

## 安全考虑

### 文件名注入

**风险**: 用户输入的字段（email, label）可能包含特殊字符

**缓解**: 文件名不包含用户输入，仅使用时间戳和随机数

### JSON 注入

**风险**: 用户输入的字段可能包含特殊字符（引号、换行符）

**缓解**: JSON.stringify 自动转义特殊字符

### XSS

**风险**: 导出的 JSON 文件可能被恶意网站读取

**缓解**: 导出文件为纯 JSON，不包含可执行代码

---

## 兼容性

### 浏览器兼容性

- `Date` API: ✅ 所有现代浏览器
- `Math.random()`: ✅ 所有现代浏览器
- `String.padStart()`: ✅ Chrome 57+, Firefox 48+
- `Blob`: ✅ 所有现代浏览器
- `URL.createObjectURL()`: ✅ 所有现代浏览器

### 向后兼容性

- 旧记录（无 machineId）：✅ 使用空字符串兜底
- 旧记录（无 label）：✅ 使用 firstName + lastName 兜底
- 失败记录（无 token）：✅ 过滤逻辑排除

---

## 测试策略

### 单元测试

1. **generateFilename()**
   - 测试文件名格式正确性
   - 测试同秒序列号递增
   - 测试随机数范围

2. **mapRecordToExport()**
   - 测试字段映射正确性
   - 测试默认值兜底
   - 测试旧记录兼容性

### 集成测试

1. **exportHistory()**
   - 测试完整导出流程
   - 测试过滤逻辑
   - 测试错误处理

### 属性测试 (PBT)

参见 proposal.md 中的 PBT Properties 章节

---

## 部署计划

### 变更范围

- 文件：`popup/popup.js`
- 函数：`exportHistory()` + 2 个新辅助函数
- 行数：约 +60 行（新增辅助函数），~20 行（修改 exportHistory）

### 回滚策略

- 保留原 exportHistory() 函数作为备份
- 如有问题，恢复原函数即可

### 监控指标

- 导出成功率
- 文件名冲突率
- 用户反馈

---

*Created by CCG:SPEC:PLAN at 2026-02-11*
