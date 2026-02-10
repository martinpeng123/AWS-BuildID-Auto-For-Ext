# OPSX Proposal: 临时邮箱服务集成

## Context

### 用户需求
接入 cloudflare_temp_email 临时邮箱服务，实现：
1. 自动创建临时邮箱地址
2. 自动接收并解析邮箱验证码
3. 无需手动输入验证码即可完成 AWS Builder ID 注册

### 当前痛点
- 现有 Gmail 别名模式需要用户手动从 Gmail 收件箱查看并输入验证码
- `manualVerification: true` 导致注册流程无法完全自动化
- 批量注册时人工操作成本高

### 用户环境
- 已有 cloudflare_temp_email 私有部署实例
- 拥有 Admin 密码（可使用 `/admin/new_address` API）
- API 地址将在插件设置中配置
- AI 验证码提取功能状态未知（需兼容两种模式）

---

## Constraint Sets (约束集合)

### 硬约束 (Hard Constraints)

| ID | 约束 | 来源 | 影响 |
|----|------|------|------|
| HC-1 | Admin API 需要 `x-admin-auth` 头 | API 文档 | 必须在设置中配置 Admin 密码 |
| HC-2 | 邮件查询 API 需要 JWT token | API 文档 | 创建邮箱后需保存返回的 JWT |
| HC-3 | Chrome 扩展 Service Worker 无 DOM | Manifest V3 | 无法使用 DOMParser，需用正则解析 |
| HC-4 | AWS 验证码格式为 6 位数字 | AWS 注册流程 | 正则: `/\b\d{6}\b/` |
| HC-5 | 邮件 API 返回 HTML 格式邮件内容 | API 测试 | 需从 HTML 中提取验证码 |
| HC-6 | manifest.json 已有 host_permissions | 现有代码 | 需添加临时邮箱 API 域名权限 |

### 软约束 (Soft Constraints)

| ID | 约束 | 推荐做法 |
|----|------|----------|
| SC-1 | AI 提取可能未启用 | 先检查 `metadata.auth_code`，无则正则解析 |
| SC-2 | 轮询间隔影响体验 | 建议 3-5 秒轮询，最长等待 5 分钟 |
| SC-3 | 邮箱可能有多封邮件 | 按时间排序，取最新含验证码的邮件 |
| SC-4 | 用户可能使用公共演示站 | 设置界面提示：公共站可能有使用限制 |

### 依赖关系 (Dependencies)

```
[创建邮箱] → [获取 JWT] → [轮询邮件] → [解析验证码] → [自动填写]
     ↓              ↓
   Admin密码      保存到session
```

### 风险项 (Risks)

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| API 限流 | 中 | 注册失败 | 添加请求间隔，使用 API 锁 |
| 邮件延迟 | 中 | 等待超时 | 增加轮询超时时间，提供重试 |
| 验证码格式变化 | 低 | 解析失败 | 多种正则模式兼容 |
| Admin 密码泄露 | 中 | 安全风险 | 使用 chrome.storage.local 加密存储 |

---

## Requirements (需求规格)

### R1: 临时邮箱服务配置

**场景**: 用户首次使用时配置临时邮箱服务

**需求**:
1. 在 popup.html 添加临时邮箱配置区域
2. 配置项包括:
   - API 地址 (必填): 如 `https://temp-email-api.example.com`
   - Admin 密码 (必填): 用于创建邮箱
   - 邮箱域名 (必填): 如 `awsl.uk`
3. 配置保存到 `chrome.storage.local`
4. 提供配置验证功能（测试连接）

**验证场景**:
```
Given 用户输入 API 地址和 Admin 密码
When 点击"测试连接"按钮
Then 显示连接成功/失败状态
```

### R2: 临时邮箱客户端实现

**场景**: 替换现有 Gmail 别名客户端

**需求**:
1. 创建 `TempEmailClient` 类，实现与 `GmailAliasClient` 相同接口
2. 核心方法:
   - `createInbox(options)`: 调用 Admin API 创建邮箱，返回地址和 JWT
   - `waitForVerificationCode(timeout)`: 轮询邮件 API，解析验证码
   - `deleteInbox()`: 可选，删除邮箱
3. 验证码提取逻辑:
   - 优先检查 `metadata.auth_code` (AI 提取)
   - 降级使用正则匹配 6 位数字

**验证场景**:
```
Given 临时邮箱服务已配置
When 调用 createInbox()
Then 返回 { address: "xxx@domain.com", jwt: "xxx" }
```

### R3: 注册流程集成

**场景**: 在注册流程中使用临时邮箱

**需求**:
1. 修改 `service-worker.js` 中的 `runSessionRegistration`
2. 根据配置选择邮箱客户端:
   - 临时邮箱模式: 使用 `TempEmailClient`
   - Gmail 别名模式: 保留现有 `GmailAliasClient`
3. 临时邮箱模式下:
   - `manualVerification = false`
   - 自动调用 `waitForVerificationCode`
   - 验证码自动填入页面

**验证场景**:
```
Given 用户配置了临时邮箱服务
And 开始注册
When 收到 AWS 验证邮件
Then 自动提取验证码并填入页面
And 无需手动操作
```

### R4: Content Script 验证码处理

**场景**: 在 AWS 注册页面自动填写验证码

**需求**:
1. 修改 `content.js` 中的验证码处理逻辑
2. 当收到 `GET_VERIFICATION_CODE` 响应时:
   - 如果 `needManualInput: false` 且有 `code`，自动填入
   - 如果 `needManualInput: true`，保持现有手动输入逻辑
3. 添加验证码自动填写后的确认逻辑

**验证场景**:
```
Given 页面处于验证码输入步骤
And 后台已获取到验证码 "123456"
When content script 请求验证码
Then 自动将 "123456" 填入输入框
And 自动点击提交按钮
```

### R5: 模式切换支持

**场景**: 用户可以在 Gmail 别名和临时邮箱模式间切换

**需求**:
1. 在设置中添加模式选择
2. 两种模式配置独立保存
3. 根据选择的模式使用对应的邮箱客户端
4. 临时邮箱模式下隐藏 Gmail 配置区域

**验证场景**:
```
Given 用户选择"临时邮箱模式"
When 查看设置界面
Then Gmail 配置区域隐藏
And 临时邮箱配置区域显示
```

---

## Success Criteria (成功判据)

| ID | 判据 | 验证方法 |
|----|------|----------|
| SC-1 | 临时邮箱配置能正常保存和读取 | 手动测试配置流程 |
| SC-2 | 能成功创建临时邮箱地址 | API 调用返回 200 |
| SC-3 | 能接收并正确解析 AWS 验证码 | 验证码为 6 位数字 |
| SC-4 | 注册流程无需手动输入验证码 | E2E 完整注册测试 |
| SC-5 | Gmail 别名模式仍可正常使用 | 回归测试 |
| SC-6 | 错误时有明确提示信息 | 模拟各类错误场景 |

---

## Implementation Files (涉及文件)

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/temp-email-api.js` | 新建 | TempEmailClient 实现 |
| `lib/mail-api.js` | 保留 | 保持 Gmail 别名逻辑 |
| `background/service-worker.js` | 修改 | 集成临时邮箱客户端 |
| `content/content.js` | 修改 | 自动填写验证码逻辑 |
| `popup/popup.html` | 修改 | 添加临时邮箱配置 UI |
| `popup/popup.js` | 修改 | 配置保存/读取逻辑 |
| `popup/popup.css` | 修改 | 新增配置区域样式 |
| `manifest.json` | 修改 | 添加 host_permissions |

---

## API Reference (API 参考)

### 创建邮箱
```http
POST /admin/new_address
Headers:
  x-admin-auth: <admin_password>
  Content-Type: application/json
Body:
  {
    "enablePrefix": true,
    "name": "<random_name>",
    "domain": "<configured_domain>"
  }
Response:
  {
    "address": "xxx@domain.com",
    "jwt": "<jwt_token>"
  }
```

### 查询邮件
```http
GET /api/mails?limit=10&offset=0
Headers:
  Authorization: Bearer <jwt_token>
Response:
  [
    {
      "id": 1,
      "subject": "Your AWS verification code",
      "text": "Your code is 123456",
      "html": "<html>...</html>",
      "metadata": {
        "auth_code": "123456"  // AI 提取（如已启用）
      },
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
```

---

## Open Questions (待确认)

1. ~~服务来源~~ → 已确认：私有部署实例
2. ~~Admin 权限~~ → 已确认：有 Admin 密码
3. ~~API 地址~~ → 已确认：稍后在设置中配置
4. ~~AI 提取~~ → 已确认：不确定，需兼容两种模式

---

## Next Steps

1. 运行 `/ccg:spec-plan` 生成详细执行计划
2. 或直接运行 `/ccg:spec-impl` 开始实现

---

*Created by CCG:SPEC:RESEARCH at 2026-02-10*
