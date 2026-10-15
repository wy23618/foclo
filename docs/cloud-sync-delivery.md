# 云端账号与同步交付入口

当前（2026-10-09）：本机服务及已记录的手机、平板基础验收保留。阿里云内部后台/数据库已部署，17表迁移摘要一致，自动加密备份、隔离恢复和整机重启通过，详见[服务器部署记录](ecs-deployment.md)。临时公网HTTPS手机开发预览扫码、微信登录和同步已通过，证书续期演练通过；正式域名/备案、体验版和完整真机专项尚未完成。总目标未完成，不称可发布版本。

无域名时的临时开发真机云端方案及真实状态见[临时IP HTTPS手机测试](temporary-ip-https-test.md)。

| 资料 | 入口 |
| --- | --- |
| 持续目标与剩余事项 | [execution-status.md](execution-status.md) |
| 简明续接清单 | [next-actions.md](next-actions.md) |
| 验收证据及 T01–T26 缺口 | [acceptance-results.md](acceptance-results.md) |
| 账号、字段、可靠提交、冲突与全量恢复设计 | [architecture-decisions.md](architecture-decisions.md) |
| 数据库结构及事务 | [database-design.md](database-design.md)、../server/migrations/001–005 |
| 最小权限部署授权 | ../server/deploy/permissions.sql（管理员在目标独立库执行，无密码） |
| 接口与示例 | [api.openapi.yaml](api.openapi.yaml)、[api-examples.md](api-examples.md) |
| 配置、自有 ECS 部署、域名/费用核实、监测与回退 | [deployment.md](deployment.md) |
| 当前试用抵扣、正式运行费用公式与预算缺口 | [cloud-budget.md](cloud-budget.md) |
| 原数据、历史视图、数据库恢复与注销流程 | [backup-recovery.md](backup-recovery.md) |
| 未来 App 接入 | [future-app-integration.md](future-app-integration.md) |
| 性能字节与本机测量 | [performance-results.json](performance-results.json) |
| 真机现场操作记录模板 | [device-acceptance.md](device-acceptance.md) |
| 当前本地验收与后续缺口 | [local-acceptance-summary.md](local-acceptance-summary.md) |
| 独立后端部署包与复验 | [backend-bundle.md](backend-bundle.md) |
| 留给用户的操作清单 | [user-handoff.md](user-handoff.md) |
| 当前运行规则与正式默认预案 | [operations-policy.md](operations-policy.md) |

小程序服务入口为 sync/config.js：开发工具使用回环地址，手机 develop 构建使用已部署的临时IP HTTPS地址；trial/release 的正式域名仍为空。后端环境变量模板为 server/.env.example；真实秘密只放受保护环境文件或云端密钥配置，不能写入小程序、提交文件或聊天。没有配置服务也能继续使用游客计时及本地统计。

代码入口：storage/account-adapter.js、storage/file-adapter.js、core/service.js、sync/accounts.js、sync/local.js、sync/worker.js、sync/snapshot-view.js、pages/account/account.*；后端 server/src/index.ts、auth.ts、sync.ts、imports.ts，SQL 与 Docker 配置在 server 下。

本地验证用 Node 24：根目录 `node --test tests/*.test.js`，server 目录 `npm ci`、`npm run build`、`npm test`。后端测试会使用真实 PostgreSQL 原生二进制；只绑定回环地址，生成样本数据，Windows 使用 ASCII 临时目录。没有 Git 历史，本次交付保存在工作区文件，未创建提交或 PR。

后续 E/F：完成剩余完整真机专项；配置公网HTTPS、合法域名、持续异地备份/删除记录和真实运营资料，再执行正式版本验收。用户已提供阿里云试用实例，代理已部署；不再要求重复购买服务器。

2026-10-08补充本地实证：DevTools受控远端删除活动项目后可靠结束、显式新ID恢复、原ID不复活；隔离磁盘迁移在上传和提交回执丢失后续传且原游客样本不变；真实拉取响应延迟5秒期间开始/暂停/恢复/结束均提前本地提交。脚本和证据位置见local-acceptance-summary.md。上述不替代手机强杀及真机大样本验收。

当前交付包：[YoTick-backend-ecs-ready-20261009-r3.zip](../server/delivery/YoTick-backend-ecs-ready-20261009-r3.zip)，SHA256 `9d55afd65b94e48178e24f0786b0dc493034f03944ccc4a4d1b2a4cb3e95026d`。包含云端Linux部署、健康检查失败自动回退、加密备份、恢复门禁和真实微信验证工具；不含密钥、数据库内容或本机调试工具。85项manifest与当前工作区逐项一致。此前包是历史阶段版本。实际云端结果与剩余条件见ecs-deployment.md；临时IP HTTPS和手机基础登录同步已验，正式域名和小程序生产请求配置尚未验；本项目在ECS运行systemd服务，没有用容器部署。
