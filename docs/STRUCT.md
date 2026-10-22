# MongoDB 数据库结构设计

## 1. 范围与约定

本阶段仅建立数据库结构与初始化能力，不包含注册、登录、问卷编辑/提交 API。MongoDB 是唯一业务数据主存储；用户、问卷、题目、规则、答卷及答案分别存放，不使用关系库或内存库替代。数据库默认 `questionnaire_system`，通过环境变量配置本地 MongoDB URI。

集合级 MongoDB `$jsonSchema` validator 检查核心字段类型和必填项，索引脚本可重复执行。跨集合引用有效性、题型配置与值的对应关系、时间/状态转换，以及题目归属同一问卷等语义约束由后续服务层校验；MongoDB validator 本身不适合跨文档外键约束。写多文档的发布、提交等流程应使用事务（本地副本集）或设计成可恢复的分步写入。

所有 `_id` 使用 MongoDB `ObjectId`；下文 `ObjectId("...")` 是示意值。时间字段 BSON Date 存 UTC。密码不存明文或可逆密文：当前测试服务使用 Node.js 内置 `scrypt` 生成带随机 salt 的 `passwordHash`；投入正式环境建议迁移为 Argon2id。注册和登录由后端验证密码。用户名规范化策略（大小写、空白）由账号服务确定，唯一索引作用于规范化后的 `username`。

## 2. 集合与字段

### `users`

存放账号本身，不存问卷或答案。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | MongoDB 主键 |
| `username` | string | 是 | 3–64 字符，唯一 |
| `passwordHash` | string | 是 | 当前为 `scrypt$salt$hash` 格式；正式环境建议 Argon2id |
| `registeredAt` | Date | 是 | 注册时间 |
| `updatedAt` | Date | 否 | 最近账号资料更新时间 |

```json
{
  "_id": "ObjectId('66a000000000000000000001')",
  "username": "alex",
  "passwordHash": "scrypt$random-salt$derived-hash",
  "registeredAt": "2026-10-22T02:00:00.000Z"
}
```

### `surveys`

存问卷级元信息，不存具体题目、答卷或统计缓存。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | 主键 |
| `ownerId` | ObjectId | 是 | 引用 `users._id` |
| `shortId` | string | 是 | URL 标识，唯一；如 `/survey/{shortId}` |
| `title` | string | 是 | 1–200 字符 |
| `description` | string | 否 | 问卷说明 |
| `allowAnonymous` | boolean | 是 | 是否允许匿名身份提交 |
| `allowMultipleResponses` | boolean | 是 | 是否允许同一用户重复提交 |
| `status` | enum | 是 | `draft`、`published`、`closed` |
| `publishedAt` | Date | 否 | 首次/最近发布时间，具体语义由服务约定 |
| `closesAt` | Date | 否 | 截止时间；运行时与当前时间比较 |
| `closedAt` | Date | 否 | 手动关闭时间 |
| `createdAt`, `updatedAt` | Date | 是 | 创建、更新时间 |

```json
{
  "_id": "ObjectId('66a000000000000000000010')",
  "ownerId": "ObjectId('66a000000000000000000001')",
  "shortId": "Svy8aK3pQ1",
  "title": "校园出行调查",
  "description": "了解同学们的通勤方式。",
  "allowAnonymous": true,
  "allowMultipleResponses": false,
  "status": "published",
  "publishedAt": "2026-10-22T02:10:00.000Z",
  "closesAt": "2026-11-01T00:00:00.000Z",
  "createdAt": "2026-10-22T02:05:00.000Z",
  "updatedAt": "2026-10-22T02:10:00.000Z"
}
```

### `questions`

一道题一份文档，存所属问卷引用、顺序、题型、题干、必答配置、题型配置/选项和校验规则。不要在此集合存跳转规则。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | 主键 |
| `surveyId` | ObjectId | 是 | 引用 `surveys._id` |
| `order` | int | 是 | 问卷内从 1 开始；`(surveyId, order)` 唯一 |
| `type` | enum | 是 | `single_choice`、`multiple_choice`、`text`、`number` |
| `prompt` | string | 是 | 题干 |
| `required` | boolean | 是 | 必答规则，统一放在题目配置中 |
| `options` | array | 选择题必需 | 选项 `{key,text,order}`；非选择题不使用 |
| `validation` | object | 是 | 题型适用的规则数据，见下例 |
| `createdAt`, `updatedAt` | Date | 是 | 维护时间 |

选项采用题目文档内嵌数组，而不是独立 `options` 集合：选项数量通常有限，随题目整体加载/编辑，独立查询与引用没有实际收益；`key` 是稳定标识，答案与跳转条件均保存 key，不依赖可修改的选项文本。修改/删除已被答卷引用的 key 需由服务层禁止或保留旧版本快照。

校验配置也嵌入题目文档：约束归属单题，和题目一起读取、编辑与校验；无需独立索引/生命周期。规则的字段名与数值来自数据，不把限制数值写死在后端代码。后端解释 `type`/`validation` 的通用运算符。新增规则种类应通过版本化配置扩展；若某类配置变得大型或需要单独管理，再迁移到独立集合。

**三种题型配置示例**（单选、多选、填空；数字填空为另一种填空配置）：

```json
{
  "_id": "ObjectId('66a000000000000000000101')",
  "surveyId": "ObjectId('66a000000000000000000010')",
  "order": 1,
  "type": "single_choice",
  "prompt": "你通常乘坐什么交通工具？",
  "required": true,
  "options": [
    {"key": "bus", "text": "公交车", "order": 1},
    {"key": "bike", "text": "自行车", "order": 2},
    {"key": "walk", "text": "步行", "order": 3}
  ],
  "validation": {"allowedOptionKeys": ["bus", "bike", "walk"]},
  "createdAt": "2026-10-22T02:06:00.000Z",
  "updatedAt": "2026-10-22T02:06:00.000Z"
}
```

```json
{
  "_id": "ObjectId('66a000000000000000000102')",
  "surveyId": "ObjectId('66a000000000000000000010')",
  "order": 2,
  "type": "multiple_choice",
  "prompt": "你一周会使用哪些方式？",
  "required": true,
  "options": [
    {"key": "bus", "text": "公交车", "order": 1},
    {"key": "bike", "text": "自行车", "order": 2},
    {"key": "walk", "text": "步行", "order": 3}
  ],
  "validation": {"minSelections": 2, "maxSelections": 3, "allowedOptionKeys": ["bus", "bike", "walk"]},
  "createdAt": "2026-10-22T02:06:00.000Z",
  "updatedAt": "2026-10-22T02:06:00.000Z"
}
```

必须选固定数量 N 时表达为 `minSelections: N, maxSelections: N`。必答与多选数量约束同时适用；服务端定义空答案与未作答的区别并统一验证。

```json
{
  "_id": "ObjectId('66a000000000000000000103')",
  "surveyId": "ObjectId('66a000000000000000000010')",
  "order": 3,
  "type": "text",
  "prompt": "请补充说明",
  "required": false,
  "validation": {"minLength": 0, "maxLength": 500, "lengthUnit": "unicode_code_points"},
  "createdAt": "2026-10-22T02:06:00.000Z",
  "updatedAt": "2026-10-22T02:06:00.000Z"
}
```

数字题示例配置：`{"min":0,"max":120,"integerOnly":true}`。手机号等整数校验用 `integerOnly:true`；不应把手机号当可参与运算的数值，后续可扩展专用文本格式校验。

### `jump_rules`

跳转规则独立成集合，不嵌入 `questions`。这样一题可配置多条有优先级的规则，规则可独立增删/查询，避免题目文档膨胀，并允许第二阶段新增条件类型；代价是加载问卷逻辑需要一次按问卷批量查询。每条规则中的目标题目引用和条件均为结构化数据，禁止存可执行代码字符串。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | 主键 |
| `surveyId` | ObjectId | 是 | 所属问卷 |
| `sourceQuestionId` | ObjectId | 是 | 触发题目 |
| `condition` | object | 是 | `answerType`、`operator` 与类型化操作数 |
| `targetQuestionId` | ObjectId | 是 | 目标题目 |
| `priority` | int | 是 | 同源多条规则的求值顺序；首条匹配规则生效 |
| `enabled` | boolean | 是 | 开关 |
| `createdAt`, `updatedAt` | Date | 是 | 维护时间 |

```json
{"surveyId":"ObjectId('66a000000000000000000010')","sourceQuestionId":"ObjectId('66a000000000000000000101')","condition":{"answerType":"single_choice","operator":"equals","optionKeys":["bus"]},"targetQuestionId":"ObjectId('66a000000000000000000103')","priority":1,"enabled":true,"createdAt":"2026-10-22T02:07:00.000Z","updatedAt":"2026-10-22T02:07:00.000Z"}
```

```json
{"surveyId":"ObjectId('66a000000000000000000010')","sourceQuestionId":"ObjectId('66a000000000000000000102')","condition":{"answerType":"multiple_choice","operator":"includes_any","optionKeys":["bike","walk"]},"targetQuestionId":"ObjectId('66a000000000000000000103')","priority":1,"enabled":true,"createdAt":"2026-10-22T02:07:00.000Z","updatedAt":"2026-10-22T02:07:00.000Z"}
```

```json
{"surveyId":"ObjectId('66a000000000000000000010')","sourceQuestionId":"ObjectId('66a000000000000000000104')","condition":{"answerType":"number","operator":"gte","value":18},"targetQuestionId":"ObjectId('66a000000000000000000105')","priority":1,"enabled":true,"createdAt":"2026-10-22T02:07:00.000Z","updatedAt":"2026-10-22T02:07:00.000Z"}
```

后端解释执行：根据 `sourceQuestionId` 取匹配的启用规则，按 `priority` 升序逐条将已验证的答案与 `condition.operator`/操作数比较，首条命中时跳到 `targetQuestionId`；无规则命中时顺序前进。发布前服务端检查引用、题号及循环风险；循环检查同时纳入规则跳转和默认顺序路线。填写时仍保留访问路径防护。比较逻辑只实现通用运算符，不包含某问卷的具体答案/数字阈值。

### `responses`

答卷头部，不嵌入逐题答案。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | 主键 |
| `surveyId` | ObjectId | 是 | 所属问卷 |
| `respondentId` | ObjectId/null | 否 | 登录用户引用；未关联身份则为 null |
| `submissionKey` | string | 否 | 禁止重复填写时的问卷作用域 HMAC 去重键；匿名答卷也可使用，不含可反查账号的原始标识 |
| `isAnonymous` | boolean | 是 | 是否匿名保存身份 |
| `status` | enum | 是 | `in_progress`、`submitted`、`abandoned` |
| `startedAt` | Date | 是 | 开始时间 |
| `submittedAt` | Date | 否 | 成功提交时间 |
| `visitedQuestionIds` | ObjectId[] | 否（新答卷会写入） | 本次填写实际访问的题目路径；用于区分跳过题、访问后未答题和已回答题 |
| `createdAt`, `updatedAt` | Date | 是 | 生命周期时间 |

```json
{"_id":"ObjectId('66a000000000000000000201')","surveyId":"ObjectId('66a000000000000000000010')","respondentId":null,"isAnonymous":true,"visitedQuestionIds":["ObjectId('66a000000000000000000101')","ObjectId('66a000000000000000000103')"],"status":"submitted","startedAt":"2026-10-22T02:20:00.000Z","submittedAt":"2026-10-22T02:25:00.000Z","createdAt":"2026-10-22T02:20:00.000Z","updatedAt":"2026-10-22T02:25:00.000Z"}
```

匿名提交时保留 `respondentId: null` 且 `isAnonymous:true`；非匿名应有用户引用且 `isAnonymous:false`。两种状态一致性由服务端检查。需求同时要求填写者登录和允许匿名，当前解释为“访问/提交需登录，但匿名选项不把账户 ID 与答卷关联”。当 `allowMultipleResponses:false` 时，服务端通过应用密钥对问卷 ID 和登录用户 ID 计算 HMAC，存入 `submissionKey`；数据库 `(surveyId, submissionKey)` 稀疏唯一索引在并发请求下阻止重复提交。该值不可反推出用户 ID，不传给客户端；应用密钥变化会改变后续计算结果，因此部署时应固定 `APP_SECRET`。允许重复填写时不写入该字段。

关闭问卷通过所有者专属 API 将 `surveys.status` 从 `published` 改为 `closed`，同时记录 `closedAt`。关闭状态不能再编辑或重新发布；公开读取及提交 API 只接受 `published` 状态，因此关闭后均拒绝访问。

### `answers`

每份答卷的每道已回答题单独一份文档。答案拆集合而不是嵌入答卷：便于按单题聚合统计和过滤，答卷大小不随题目数增长到单文档上限，并降低多人并发写同一个答卷文档时的争用。代价是提交和统计需跨文档操作；`(responseId, questionId)` 唯一索引保证同一答卷一题只有一条当前答案。若要保存修改历史，可新增版本/事件集合而不是覆盖此唯一记录。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `_id` | ObjectId | 是 | 主键 |
| `responseId` | ObjectId | 是 | 引用 `responses._id` |
| `surveyId` | ObjectId | 是 | 冗余问卷 ID，用于统计免去反复 join |
| `questionId` | ObjectId | 是 | 引用 `questions._id` |
| `questionType` | enum | 是 | 写入时题型快照，用于解释聚合和值 |
| `value` | mixed | 是 | 单选 string key；多选 string[]；文本 string；数字 BSON number |
| `answeredAt` | Date | 是 | 最近回答时间 |
| `questionOrderSnapshot` | int | 否 | 作答时题目顺序快照 |

```json
{"_id":"ObjectId('66a000000000000000000301')","responseId":"ObjectId('66a000000000000000000201')","surveyId":"ObjectId('66a000000000000000000010')","questionId":"ObjectId('66a000000000000000000101')","questionType":"single_choice","value":"bus","answeredAt":"2026-10-22T02:22:00.000Z","questionOrderSnapshot":1}
```

**答案值示例：**单选 `"bus"`；多选 `["bus","bike"]`；文本 `"每日步行约 10 分钟"`；数字 `21`。

## 3. 引用关系

```text
users 1 ── N surveys (surveys.ownerId)
surveys 1 ── N questions (questions.surveyId)
surveys 1 ── N jump_rules (jump_rules.surveyId)
questions 1 ── N jump_rules (sourceQuestionId / targetQuestionId)
surveys 1 ── N responses (responses.surveyId)
users 0..1 ── N responses (responses.respondentId，可空)
responses 1 ── N answers (answers.responseId)
questions 1 ── N answers (answers.questionId)
```

所有上述业务关系均使用 ObjectId 引用，而非复制整份文档。创建者引用而非嵌入用户信息，是因为账号独立管理、用户可拥有多份问卷，且用户资料变更不应复制更新到问卷。删除策略需由服务层明确（推荐软删除/限制删除，保留问卷和答卷归属）。

## 4. 冗余与一致性

| 冗余位置 | 理由 | 一致性维护 |
|---|---|---|
| `answers.surveyId` | 单题统计直接按问卷/题目过滤，避免逐条关联 responses | 写答案时从 response 校验并复制；答卷所属问卷不可变；巡检脚本可核验 |
| `answers.questionType` | 历史答案解释及统计时不必逐条读取题目；题型改变不应误解旧值 | 发布后禁止原位改变有答案题目的类型；若需编辑结构应版本化问卷/题目 |
| `answers.questionOrderSnapshot`（可选） | 保留作答时展示顺序，题目重排不改变历史上下文 | 写入时从题目复制，仅作审计/历史快照，不回写 |
| `responses.visitedQuestionIds` | 区分“规则跳过”“访问但未答”和“已答”，并支持核验客户端提交路径 | 服务端按题目答案和启用的跳转规则重建路径后写入；旧答卷无此字段时统计明确标记访问数据不完整，不做猜测 |
| `questions.options` / `questions.validation` | 不是跨集合冗余，是同一题的内聚配置 | 题目文档原子更新；引用选项 key 的规则/答案更新限制或版本化 |

不维护题目选项计数、答卷总数等预计算统计。统计直接聚合已提交答卷的 `answers`；避免答案写入与计数器更新出现双写不一致。若未来负载要求统计缓存，新增可重建的派生集合并采用事务/变更流或周期性全量重算，明确其非事实源。

## 5. 索引与统计查询

初始化脚本建立核心索引：用户名唯一、短链接唯一、创建者问卷列表、问卷题目顺序唯一、规则按问卷/源题/优先级检索、按问卷获取已提交答卷、答案唯一性与题目统计。索引不等于访问控制；列出问卷/统计 API 必须以已认证的 `ownerId` 校验所有权。

| 指标 | 数据来源 | 计算方法 |
|---|---|---|
| 问卷提交数 | `responses` | `surveyId + status=submitted` 的 `$count` |
| 题目已访问、被跳过、访问后未答 | `responses.visitedQuestionIds` + `answers` | 按已提交答卷的实际路径统计；没有历史路径字段的旧答卷令 `visitDataComplete=false`，访问类指标返回 `null`，不通过空答案猜测 |
| 单选各选项人数、作答总数 | `answers` | 过滤 `surveyId/questionId/questionType=single_choice`，按 `value` `$group` 计数；有效答案文档数为回答数 |
| 多选各选项选择次数 | `answers` | `$unwind: "$value"` 后按选项 key `$group` 计数；可另数答案文档得到回答人数 |
| 填空全部内容 | `answers` | 按 `surveyId/questionId` 查询文本值，分页并限制权限 |
| 数字平均值 | `answers` | 过滤 number 类型，按数值 `$avg`；必要时 `$convert` 并处理缺失/无效值 |
| 单题统计 | `answers` | 按 `questionId` 查询/聚合；服务端先验证问卷拥有权 |
| 问卷整体统计 | `questions` + `answers` | 先加载问卷题目，再批量聚合答案，返回按题目组织的结果 |

统计仅计入 `responses.status="submitted"` 对应答案。稳妥实现是通过 `$lookup` 关联 responses 过滤提交状态；或保证只在最终提交事务内写答案并将状态一并提交。中间保存答案则必须在聚合中关联状态。

## 6. 数据驱动逻辑

- 单选配置由 `type=single_choice`、`options`、`required` 与 `validation.allowedOptionKeys` 表达；提交值为单个 option key。
- 多选配置用 `validation.minSelections`、`maxSelections`、`allowedOptionKeys`；固定 N 个通过 min=max=N 表达。
- 文本填空用 `minLength`、`maxLength`、`lengthUnit`；数字填空用 `min`、`max`、`integerOnly`。这些值来自题目文档而不是硬编码业务阈值。
- 跳转以集合中的条件类型、运算符、操作数、目标题目 ID、优先级和启用状态表达。后端解释通用运算符；不执行字符串表达式，不允许配置运行任意代码。
- `db/init.js` 为核心结构建立 schema validator；具体变体联合约束可由后端 schema/校验模块继续强化，但数据库不能代替业务验证。

## 7. 第二阶段扩展点

新增题型可扩展 `questions.type`、对应 `validation/config` 形状及答案 `value` 表达，不必重构问卷/答卷关系。新增跳转类型可扩展 `condition.answerType/operator` 与解释器。新增统计指标以 `answers` 聚合为基础；高负载时新增派生统计集合，不把缓存混入事实集合。问卷发布版本可增加 `version`/版本集合并令 responses 指向版本，以保留历史题目、规则及选项快照。多语言、题目分组、草稿协作、审计日志、逻辑分支组合也可通过新增字段/集合逐步加入。

## 8. 复现

安装 Node.js 20+、本地 MongoDB 7+。复制 `.env.example` 为 `.env`，确认 MongoDB 在 URI 端口监听，然后在 Windows PowerShell 运行 `npm.cmd ci` 和 `npm.cmd run db:init`（macOS/Linux 使用 `npm ci` 和 `npm run db:init`）。脚本仅创建/调整 validator 和索引，不清空或重建数据；若既有集合包含不符合新 validator 的文档，后续写入会被拒绝，应先人工迁移数据。脚本需要 MongoDB `createCollection`、`collMod`、`createIndex` 权限。
