# 问卷系统第二阶段

这是基于第一阶段代码继续扩展的独立二阶段工程，包含题目库、题目版本、题目共享、题目使用查询、跨问卷统计和问卷库。

## 启动

环境要求：Node.js 20+、本地 MongoDB 7+。

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run db:init
npm.cmd start
```

默认使用独立数据库 `questionnaire_system_phase2` 和端口 `3002`，访问 `http://localhost:3002`。不会使用第一阶段的业务数据库。

## 验证

```powershell
npm.cmd run verify
npm.cmd run verify:phase2
```

第一条命令验证第一阶段兼容功能，第二条命令验证题目版本链、题库复用、问卷库模板复制、题目使用关系和跨问卷统计；这两条命令只清理各自创建的临时数据。工作台“功能验证”会创建名称带`测试用`前缀的问卷、题目、规则、答卷和题库，并保留数据供页面检查；完成后点击“一键删除测试数据”清理。

## 项目文档

提交文档包括[系统说明](docs/系统说明.md)、[数据库设计](docs/数据库设计.md)、[API说明](docs/API说明.md)和[关键逻辑说明](docs/关键逻辑说明.md)。完整项目完成报告见[docs/实验报告.md](docs/实验报告.md)，AI使用过程见[docs/AI_RICORD.md](docs/AI_RICORD.md)。
