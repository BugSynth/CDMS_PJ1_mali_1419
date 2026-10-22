# API 与复现说明

## 运行环境

- Node.js 20 或更高版本。
- 本地 MongoDB 7 或更高版本，默认连接 `mongodb://127.0.0.1:27017`。
- Windows PowerShell 下建议使用 `npm.cmd`，避免执行策略阻止 `npm.ps1`。

## 启动步骤

1. 复制 `.env.example` 为 `.env`，需要时修改 `MONGODB_URI`、`MONGODB_DB`、`PORT` 和 `APP_SECRET`。
2. 在项目目录运行 `npm.cmd ci`（macOS/Linux 使用 `npm ci`）。
3. 运行 `npm.cmd run db:init`，创建或更新六个业务集合的 validator 和索引。初始化不会清空业务数据。
4. 运行 `npm.cmd start`，访问 `http://localhost:3000`。
5. 注册或登录后即可创建问卷；工作台内的“功能验证”可运行并展示可检查的验证证据。

`npm.cmd run verify` 会创建临时账号、问卷、答卷并在结束时清理。`npm.cmd run db:reset` 会清空六个业务集合，仅应在明确需要复位时使用。验证脚本会连接 `.env` 指定的 MongoDB 数据库和已运行服务，建议使用专用测试数据库。

## 认证

注册和登录成功响应包含短期 token。除健康检查、注册和登录外，API 均要求请求头 `Authorization: Bearer <token>`。密码以带随机 salt 的 scrypt 哈希保存，不保存明文。

“匿名填写”仍需登录访问问卷；它表示答卷的 `respondentId` 设为 `null`，并记录 `isAnonymous: true`。若问卷禁止重复填写，服务端另存按问卷和登录账号计算的 HMAC 去重键；该键不可用于反查账号，且不暴露给客户端。允许重复填写时不生成此键。

## 接口

| 方法 | 路径 | 请求/用途 | 成功响应 |
|---|---|---|---|
| GET | `/api/health` | 检查服务和数据库配置 | `{ ok, database }` |
| POST | `/api/register` | JSON `{ username, password }`；用户名 3–64 字符，密码至少 8 字符 | `{ token, user }` |
| POST | `/api/login` | JSON `{ username, password }` | `{ token, user }` |
| GET | `/api/surveys` | 当前用户的问卷列表 | 问卷数组 |
| POST | `/api/surveys` | 新建问卷；JSON 见下方问卷格式 | `201`，问卷信息 |
| GET | `/api/surveys/:shortId/edit` | 所有者读取草稿及题目/规则 | `{ survey, questions, jumpRules }` |
| PUT | `/api/surveys/:shortId` | 更新草稿；`status: "published"` 时发布 | `{ updated, published }` |
| DELETE | `/api/surveys/:shortId` | 所有者删除问卷及关联记录 | 删除标记和各集合删除数量 |
| POST | `/api/surveys/:shortId/close` | 所有者关闭已发布问卷 | `{ closed, closedAt }` |
| GET | `/api/surveys/:shortId/stats` | 所有者查询统计 | `{ submittedCount, visitDataComplete, questions }` |
| GET | `/api/public-survey/:shortId` | 登录后读取已发布问卷 | 问卷、题目和跳转规则 |
| POST | `/api/public-survey/:shortId/responses` | 登录后提交答卷 | `201`，`{ submitted: true }` |

新建问卷的主要 JSON 形状：

```json
{
  "title": "校园出行调查",
  "description": "了解通勤方式",
  "allowAnonymous": false,
  "allowMultipleResponses": true,
  "status": "draft",
  "questions": [
    {
      "type": "number",
      "prompt": "年龄",
      "required": true,
      "validation": { "min": 0, "max": 120, "integerOnly": true }
    }
  ],
  "jumpRules": [
    {
      "sourceOrder": 1,
      "targetOrder": 3,
      "priority": 1,
      "condition": { "answerType": "number", "operator": "gte", "value": 18 }
    }
  ]
}
```

答卷提交使用题目顺序作为答案键，并提交实际访问顺序。例如：

```json
{
  "answers": { "1": 20, "3": "成人路线", "4": 5 },
  "visitedOrders": [1, 3, 4]
}
```

服务端会重新计算跳转路径并校验 `visitedOrders`，不会信任浏览器自行声明的路径。校验失败返回 `400`；未登录/登录失效返回 `401`；重复提交返回 `409`；问卷不存在、未发布或已截止返回 `404`。错误响应格式为 `{ "error": "原因" }`。

## 规则与统计

- 题型数值、必答、选项和填空约束保存在 MongoDB 的题目文档中，服务端按配置解释。
- 跳转条件为结构化条件，不执行配置中的代码字符串。发布时检查规则路线和默认顺序路线是否形成循环。
- 统计仅纳入已提交答卷；跳转统计读取 `responses.visitedQuestionIds`，选择题按答案值计数，多选先展开选项数组，数字题计算平均值，文本题返回答案内容。
- 所有者可通过 `POST /api/surveys/:shortId/close` 关闭已发布问卷；关闭后公开读取和提交均返回 `404`，已关闭问卷不可重新编辑或发布。
- 当 `allowMultipleResponses` 为 `false` 时，每个已登录账号最多提交一次，匿名模式也适用；MongoDB 稀疏唯一索引处理并发重复提交。

更多集合字段、索引和冗余一致性说明见 `STRUCT.md`；项目迭代过程见 `PROCESS.md`；完整实验报告见 `实验报告.md`。
