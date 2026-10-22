# 第一阶段提交包

本目录包含问卷系统第一阶段代码、MongoDB 初始化脚本、运行配置样例、系统/API/数据库说明、流程与 AI 使用记录和测试脚本。

## 运行

环境要求：Node.js 20+、本地 MongoDB 7+。

1. 复制 `.env.example` 为 `.env`，按需设置 MongoDB 地址、数据库名、端口和应用密钥。
2. 在本目录运行 `npm.cmd ci`（macOS/Linux 使用 `npm ci`）。
3. 运行 `npm.cmd run db:init` 初始化集合校验器和索引。
4. 运行 `npm.cmd start`，打开 `http://localhost:3000`。
5. 注册账号后，可在工作台创建、编辑、发布、手动关闭问卷、填写问卷和查看统计；“功能验证”可以运行可查看证据的端到端验证。

复现细节和 API 格式见 `docs/API.md`，数据库字段及关系见 `docs/STRUCT.md`。

## 命令

- `npm.cmd run db:init`：幂等创建/更新 MongoDB validator 和索引，不清空数据。
- `npm.cmd run verify`：运行 API 与业务逻辑验证，并自动清理验证数据；脚本使用当前 `.env` 指定的数据库，建议使用专用测试数据库。
- `npm.cmd run db:reset`：清空六个业务集合。仅在明确需要复位时运行。
- `npm.cmd start`：启动网页和 API 服务。

Windows PowerShell 下使用 `npm.cmd` 可避免执行策略拦截 `npm.ps1`；macOS/Linux 使用 `npm`。`.env`、`node_modules` 和 MongoDB 数据目录不包含在提交包中；按上述步骤即可从干净环境恢复运行。禁止重复填写时，匿名答卷仍不保存账号 ID，但服务端会保存按问卷作用域生成的不可逆去重键。

## 文件清单

- `server.js`：Node.js HTTP 服务与业务逻辑。
- `public/`：前端页面、交互脚本和样式。
- `db/init.js`：MongoDB 集合 validator 与索引。
- `scripts/`：数据库复位和可重复验证脚本。
- `docs/API.md`：运行、认证、API、规则和统计说明。
- `docs/STRUCT.md`：集合字段、关系、示例、冗余、统计和扩展设计。
- `docs/PROCESS.md`：需求追踪、设计决策、流程和验证记录。
- `docs/AI_RICORD.md`：AI 使用过程记录。
