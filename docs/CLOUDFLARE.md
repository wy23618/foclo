# Foclo · Cloudflare API

## 当前部署状态

- 主 API：[`https://api.foclo.hellovian.com`](https://api.foclo.hellovian.com)
- Workers 备用地址：[`https://foclo-api.hellovian.workers.dev`](https://foclo-api.hellovian.workers.dev)
- 存储：Cloudflare Worker + SQLite Durable Object（`FOCLO_DB`）
- 健康检查：`/health/live`、`/health/ready` 返回 200；匿名 `/api/v1/me` 返回预期 401。
- Foclo PostgreSQL 数据已在 2026-10-16 停写后迁移到 Durable Object。导入回执 SHA-256：`d974aff6a2f03ad09cd3d8f97cd14747ee0fcc7ca2ea443adbf34c4b3a281c66`。
- 微信 request 合法域名由小程序所有者确认已配置。小程序前端仍由微信开发者工具上传，真实设备登录和同步验收待完成。

## 数据迁移结果

导入使用 PostgreSQL 一致性逻辑快照；原 PostgreSQL 加密备份和数据库都保留在旧服务器上。没有直接导入 PostgreSQL SQL dump。转换覆盖 PostgreSQL UUID、JSONB、bytea、时间、布尔与整数值；业务 ID、账号身份、登录会话、同步状态、回执和删除标记均随 16 张业务表迁移。导入在 Durable Object SQLite 事务内完成，目标非空保护、列校验和 `PRAGMA foreign_key_check` 均通过，之后写入单次导入回执。

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| users | 2 | spaces | 2 |
| auth_identities | 2 | auth_sessions | 23 |
| auth_session_refresh_history | 148 | projects | 27 |
| study_sessions | 69 | pauses | 56 |
| account_preferences | 1 | sync_operations | 136 |
| sync_changes | 126 | sync_snapshots | 5 |
| snapshot_items | 87 | import_jobs | 4 |
| import_items | 4 | account_deletion_requests | 0 |

导入回执的哈希和每张表的行数与停写快照一致。源库抽查的全部关联完整性检查没有孤儿记录。项目和专注记录的软删除标记、同步删除标记也包含在已校验的导入包中。原 PostgreSQL 数据库仍保留用于回退；旧 `yotick.service` 保持停止，避免新旧库同时写入。

旧服务只能在 Cloudflare 尚未接收新写入时直接恢复。Cloudflare 开始接收新写入后，回退必须先把新增数据反向迁回旧库，不能简单启动旧服务切回。

## 架构和本地开发

`server/cloudflare/worker.mjs` 使用 Fetch 路由注册现有认证与同步处理器。Durable Object 负责持久化、串行请求和事务，不使用 VPS、常驻 Node 服务或 PostgreSQL。迁移后的数据位于命名空间 `foclo-v1`；不要更改 Durable Object 类名、迁移标签或命名空间逻辑，否则可能得到新的空库。

```sh
cd server
npm ci
# 复制 .dev.vars.example 到 .dev.vars，并填写开发配置
npm run dev:cloudflare
npm run build
npm run test:cloudflare
```

线上秘密由 `wrangler secret` 管理：`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`TOKEN_PEPPER`、`CURSOR_SECRET`。两个随机密钥需至少 32 字符且互不相同。绝不把真实 `.env`、`.dev.vars`、Token、数据库备份或用户数据提交到 Git。

## 小程序 API 配置与发布

`sync/environment.js` 中的 `FOCLO_API_BASE_URL` 是开发、体验和正式版本共用的 API 地址。小程序 request 合法域名应为 `https://api.foclo.hellovian.com`，不能填写路径或端口。网页打开 API 地址只会显示健康接口，不会展示小程序界面。

修改小程序前端后先运行根目录回归测试，再用微信开发者工具真机验证登录、读取已有项目和专注记录、创建/修改/删除测试记录及同步。最后由小程序管理员在微信开发者工具上传代码，并按微信审核流程发布；GitHub push 不会自动发布小程序。

## Cloudflare 自动部署

仓库 `.github/workflows/deploy.yml` 在 PR 和 `main` push 时执行检查；`main` 检查通过后自动部署 API Worker。仓库 Actions 需要 `CLOUDFLARE_ACCOUNT_ID` 和最小权限 `CLOUDFLARE_API_TOKEN`。例行开发流程：

```sh
git add .
git commit -m "Describe the change"
git push
```

部署后复核 `https://api.foclo.hellovian.com/health/ready`。只有后端 Worker 随 GitHub Actions 自动发布；微信小程序包仍须由微信平台上传和发布。

## 迁移工具安全说明

`server/cloudflare/migrate.mjs` 导出带 SHA-256 的逻辑备份，并只允许通过临时 `MIGRATION_TOKEN` 向全空目标执行一次原子导入。导入拒绝非空目标、重复回执、schema 不匹配或外键错误。备份含个人数据，只应放在访问受限的本地临时目录，验证后及时清理；严禁提交至 GitHub。

成本按 Cloudflare 当前方案和配额运行。平台要求启用付费能力时，应先确认控制台显示的费用再操作。
