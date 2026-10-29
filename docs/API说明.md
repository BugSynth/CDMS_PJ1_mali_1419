# API说明

## 1. 通用约定

接口返回JSON。除注册、登录、健康检查和读取已发布问卷外，管理接口都需请求头`Authorization: Bearer <token>`。服务端从令牌取得当前用户，不接受客户端传入的所有者ID。成功响应使用`200`或`201`；参数不合法为`400`，未登录为`401`，无权或资源不存在为`404`，状态冲突、重复名称或删除保护为`409`。

## 2. 账号与问卷接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/register` | 注册账号并返回令牌 |
| `POST` | `/api/login` | 登录并返回令牌 |
| `GET` | `/api/surveys` | 查询当前用户的问卷列表 |
| `POST` | `/api/surveys` | 创建问卷草稿及题目、规则 |
| `GET` | `/api/surveys/:shortId/edit` | 读取自己的草稿编辑数据 |
| `PUT` | `/api/surveys/:shortId` | 保存草稿或发布问卷 |
| `DELETE` | `/api/surveys/:shortId` | 删除问卷及其答卷、答案、题目和规则 |
| `GET` | `/api/public-survey/:shortId` | 读取已发布问卷 |
| `POST` | `/api/public-survey/:shortId/responses` | 提交答案与访问路径 |
| `GET` | `/api/surveys/:shortId/stats` | 读取问卷统计 |

创建或保存问卷的请求体包含标题、说明、匿名与重复填写设置、状态、题目数组及跳转规则数组。提交答卷的请求体为`answers`和`visitedOrders`；服务端不直接信任`visitedOrders`，会按照规则重新计算。

## 3. 题库与题目版本接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/api/question-banks` | 查询或创建题库 |
| `DELETE` | `/api/question-banks/:id` | 删除空题库 |
| `POST` | `/api/question-banks/:id/share` | 将题库共享给指定用户 |
| `GET/POST` | `/api/question-templates` | 查询可用题目版本或创建初始版本 |
| `POST` | `/api/question-templates/:id/versions` | 基于当前版本创建命名新版本 |
| `POST` | `/api/question-templates/:id/clone` | 复制为独立的新逻辑题 |
| `GET` | `/api/question-templates/:id/history` | 读取版本历史、来源和当前版本 |
| `POST` | `/api/question-templates/:id/restore` | 切换当前版本指针 |
| `DELETE` | `/api/question-templates/:id/versions/:version` | 删除未被使用的单个版本 |
| `DELETE` | `/api/question-templates/:id/chain` | 删除整道题及所有版本 |
| `GET` | `/api/question-templates/:id/usage` | 查询题目版本的问卷使用关系 |
| `GET` | `/api/question-stats/:id` | 查询题目跨问卷统计 |

创建版本时请求体包含`versionName`和完整题目配置。第11个版本返回`409`。回溯接口只更新当前版本，不增加版本数量。删除整题或版本时，服务端先检查问卷快照引用，引用存在时返回`409`。

## 4. 问卷库接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/survey-templates` | 查询当前用户的问卷模板 |
| `POST` | `/api/survey-templates` | 将自己的草稿保存为模板 |
| `DELETE` | `/api/survey-templates/:id` | 删除自己的模板 |

当前服务端提供模板列表、从草稿保存模板和删除模板接口。工作台在问卷库选择模板后，将模板快照载入编辑器；用户保存时通过普通`POST /api/surveys`创建新问卷及题目、规则文档。新问卷与模板相互独立，后续删除模板不会删除新问卷。

## 5. 示例

创建题库：

```json
POST /api/question-banks
{"name":"通用人口信息"}
```

创建题目版本：

```json
POST /api/question-templates/<id>/versions
{"versionName":"年龄范围调整","question":{"type":"number","prompt":"年龄","required":true,"validation":{"min":0,"max":120,"integerOnly":true}}}
```

完整请求字段、响应示例和错误说明以`server.js`中的接口实现为准。
