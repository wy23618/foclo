# 云端账号与同步交付入口

当前：本机实现与自动化验证已完成；开发者工具模拟器已实际微信登录并完成本机首次同步。公网/云部署、手机/双设备、体验版验收未完成。总目标仍未完成；关键发布检查未通过前，不称可发布版本。

| 资料 | 入口 |
| --- | --- |
| 持续目标与剩余事项 | [execution-status.md](execution-status.md) |
| 验收证据及 T01–T26 缺口 | [acceptance-results.md](acceptance-results.md) |
| 账号、字段、可靠提交、冲突与全量恢复设计 | [architecture-decisions.md](architecture-decisions.md) |
| 数据库结构及事务 | [database-design.md](database-design.md)、../server/migrations/001–005 |
| 最小权限部署授权 | ../server/deploy/permissions.sql（管理员在目标独立库执行，无密码） |
| 接口与示例 | [api.openapi.yaml](api.openapi.yaml)、[api-examples.md](api-examples.md) |
| 配置、CloudBase 部署、费用核实、监测与回退 | [deployment.md](deployment.md) |
| 原数据、历史视图、数据库恢复与注销流程 | [backup-recovery.md](backup-recovery.md) |
| 未来 App 接入 | [future-app-integration.md](future-app-integration.md) |
| 性能字节与本机测量 | [performance-results.json](performance-results.json) |
| 真机现场操作记录模板 | [device-acceptance.md](device-acceptance.md) |

小程序的公开服务入口为 sync/config.js 的 apiBaseUrl，当前为空。后端环境变量模板为 server/.env.example；真实秘密只放受保护环境文件或云端密钥配置，不能写入小程序、提交文件或聊天。没有配置服务也能继续使用游客计时及本地统计。

代码入口：storage/account-adapter.js、storage/file-adapter.js、core/service.js、sync/accounts.js、sync/local.js、sync/worker.js、sync/snapshot-view.js、pages/account/account.*；后端 server/src/index.ts、auth.ts、sync.ts、imports.ts，SQL 与 Docker 配置在 server 下。

本地验证用 Node 24：根目录 `node --test tests/*.test.js`，server 目录 `npm ci`、`npm run build`、`npm test`。后端测试会使用真实 PostgreSQL 原生二进制；只绑定回环地址，生成样本数据，Windows 使用 ASCII 临时目录。没有 Git 历史，本次交付保存在工作区文件，未创建提交或 PR。

下一步仅需继续已有 E/F 工作：安全配置测试资源，实际构建部署，真实微信及两真机验收，确定政策和运行责任。无需再确认是否继续，也无需重复 A–D 的完整调查。
