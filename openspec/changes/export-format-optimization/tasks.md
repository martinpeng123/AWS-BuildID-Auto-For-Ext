# Implementation Tasks: JSON 导出格式优化

## 任务清单

### Task 1: 添加辅助函数 - generateFilename() ✅

**优先级**: P0（必须）

**描述**: 在 `popup/popup.js` 中添加文件名生成函数

**位置**: `popup/popup.js`（在 exportHistory() 函数之前）

**验收标准**:
- [x] 函数返回符合格式 `^\d{14}-\d{6}(-\d+)?\.json$` 的文件名
- [x] 同秒内多次调用，序列号递增
- [x] 跨秒调用，序列号重置为 0

**依赖**: 无

---

### Task 2: 添加辅助函数 - mapRecordToExport() ✅

**优先级**: P0（必须）

**描述**: 在 `popup/popup.js` 中添加字段映射函数

**位置**: `popup/popup.js`（在 generateFilename() 之后）

**验收标准**:
- [x] 函数返回包含所有必需字段的对象
- [x] 所有字段都有默认值兜底
- [x] 旧记录（无 machineId）返回空字符串

**依赖**: 无

---

### Task 3: 修改 exportHistory() 函数 ✅

**优先级**: P0（必须）

**描述**: 修改 `popup/popup.js` 中的 exportHistory() 函数，使用新的辅助函数

**位置**: `popup/popup.js:569-624`

**验收标准**:
- [x] 导出的 JSON 文件名符合新格式
- [x] 导出的 JSON 内容包含所有必需字段
- [x] 过滤逻辑保持不变
- [x] 错误处理完善（捕获所有异常）

**依赖**: Task 1, Task 2

---

### Task 4: 修改 copyRecord() 函数 ✅

**优先级**: P0（必须）

**描述**: 修改 `popup/popup.js` 中的 copyRecord() 函数，输出 JSON 格式

**位置**: `popup/popup.js:394-405`

**验收标准**:
- [x] 复制输出为格式化的 JSON 字符串
- [x] JSON 结构与 mapRecordToExport() 输出一致
- [x] 包含所有必需字段

**依赖**: Task 2

---

### Task 5: 修改 saveToHistory() 函数 ✅

**优先级**: P0（必须）

**描述**: 修改 `background/service-worker.js` 中的 saveToHistory() 函数，添加 machineId 字段

**位置**: `background/service-worker.js:497-511`

**验收标准**:
- [x] record 对象包含 machineId 字段
- [x] machineId 值来自 session.oidcAuth?.deviceCode
- [x] deviceCode 为空时使用空字符串

**依赖**: 无

---

### Task 6: 手动测试

**优先级**: P0（必须）

**描述**: 手动测试导出和复制功能

**测试用例**:

1. **基本功能测试**
   - [ ] 导出一次，检查文件名格式
   - [ ] 导出一次，检查 JSON 内容字段完整性
   - [ ] 复制一条记录，检查 JSON 格式正确

2. **复制格式测试**
   - [ ] 复制后粘贴，验证是有效 JSON
   - [ ] 比较复制和导出的字段结构一致

3. **machineId 测试**
   - [ ] 注册新账号，验证 machineId 非空
   - [ ] 旧记录 machineId 为空字符串

**依赖**: Task 3, Task 4, Task 5

---

### Task 7: 多模型审查 ✅

**优先级**: P1（推荐）

**描述**: Codex + Gemini 并行审查

**检查项**:
- [x] 正确性审查（Codex）- 发现 copyRecord 缺少错误处理，已修复
- [x] 可维护性审查（Gemini）- 确认模式一致性良好

**发现的问题及处理**:
1. ⚠️ copyRecord() 缺少错误处理 → 已添加 try/catch
2. ⚠️ record 不存在时无提示 → 已添加 "找不到该记录" 提示
3. ℹ️ 敏感凭据暴露风险 → 已有行为，暂不改动（用户知情）
4. ℹ️ machineId 语义与 deviceCode → 符合规格要求，保持现状

**依赖**: Task 4, Task 5

---

## 任务依赖图

```
Task 1 (generateFilename) ✅
  │
  └───────┐
          │
Task 2 ✅ ├── Task 3 (exportHistory) ✅
          │
          └── Task 4 (copyRecord) ✅

Task 5 (saveToHistory) ✅

Task 3,4,5 ──┬── Task 6 (测试)
             │
             └── Task 7 (审查)
```

---

*Updated by CCG:SPEC:IMPL at 2026-02-11*
