# Foclo · Cloudflare API

## 当前状态（2026-10-15）

本地前端 103 项、原后端 29 项验收通过。新增 Workers 运行时测试已验证认证、幂等同步、冲突回滚、快照、导入、刷新令牌重试、账号隔离和注销。2026-10-15 已部署 Cloudflare Worker、配置小程序登录 secrets，并验证两种 HTTPS 地址、健康检查及匿名鉴权。

正式 API 地址：[`https://api.foclo.hellovian.com`](https://api.foclo.hellovian.com)。备用地址：`https://foclo-api.hellovian.workers.dev`。两个地址的 `/health/ready` 均返回 200，匿名 `/api/v1/me` 返回 401。

## 架构

`server/cloudflare/worker.mjs` 使用 Fetch 路由注册原认证与同步处理器，SQLite Durable Object 管理持久化与事务。适配器只支持项目当前使用的 SQL，不是通用 PostgreSQL 驱动。整个服务的请求经单个数据实例串行处理，适合当前规模；大规模账号分片是后续工作。

原 PostgreSQL 入口、迁移与验收仍保留用于兼容，Cloudflare 不依赖这些运维服务。

```sh
cd server
npm ci
npm run build
npm run test:cloudflare
npx wrangler secret put WECHAT_APP_ID
npx wrangler secret put WECHAT_APP_SECRET
npx wrangler secret put TOKEN_PEPPER
npx wrangler secret put CURSOR_SECRET
npm run deploy
```

本地 `.dev.vars` 使用 `.dev.vars.example` 的结构。线上四项秘密必须全部配置，两个随机密钥至少 32 字符且互不相同。未配置 API 返回 503；健康检查正常不代表微信登录已验收。

## 验证与切换

- GET `/health/live` 与 `/health/ready` 应返回 200。
- GET `/api/v1/me` 在匿名状态应返回 401；不能仅凭 200 健康检查宣布登录和同步成功。
- 在微信平台配置合法 request 域名，完成真实设备登录、离线记录上传、重试和另一设备读取。
- 当前小程序仍保留既有 API 地址；数据迁移验收前不要切换，避免已有用户连接空库。
- 前端包通过微信开发者工具上传、审核、发布，不由 Cloudflare 或 GitHub Actions 自动绕过。

## 现有数据迁移

新增云库与原 PostgreSQL 正式库隔离。迁移须先一致性备份，转换 UUID、bigint、JSON、时间和 bytea 数据，校验账号与记录数量、同步版本、幂等回执及密钥，然后在独立新库完成恢复测试。禁止直接导入 PostgreSQL dump 到 SQLite，禁止在 Git 中提交任何 dump。

Foclo Worker 的 Durable Object 当前为空库。没有执行真实用户数据迁移，也没有切换正式客户端。当前本地 `.env` 指向的 PostgreSQL 不在线；历史云端备份日期较旧，无法证明覆盖当前用户数据，因此没有用旧备份覆盖或代替现有数据库。取得当前源库一致性备份后可导入这个空 Worker；在此之前保持当前小程序客户端地址。需要修改现有正式数据时由所有者明确批准；回滚时保留两端数据和迁移记录。

## 自动发布

仓库的 `.github/workflows/deploy.yml` 在 pull request 执行检查，在 `main` 的 push / 手动运行检查通过后执行正式发布。检查工作流已上传；GitHub Actions 发布还需添加下列 secrets。请勿同时启用两个互相覆盖的发布系统。

需要在 GitHub 仓库 Settings → Secrets and variables → Actions 配置：

- `CLOUDFLARE_ACCOUNT_ID`：你自己的 Cloudflare Account ID。
- `CLOUDFLARE_API_TOKEN`：仅具备目标账号所需 Workers 发布权限的 API Token。不要把 token 放在代码、聊天或 README 中。

Worker 运行时密码与密钥通过 `wrangler secret put` 管理，不放在构建变量、前端 bundle 或仓库文件中。Cloudflare 插件、Wrangler 本地登录和 GitHub Actions 发布凭据是三种独立授权，不能假定其中一次登录会自动配好另外两者。

日常流程：本地修改 → 本地检查 → `git add .` → `git commit` → `git push` → GitHub Actions 检查 → Wrangler 发布 → 检查正式 HTTPS 地址。发布失败时保留上一线上版本，修复后再次 push。

## 成本与数据边界

配置面向 Cloudflare 免费能力，没有启用付费订阅或自动扩容。实际使用受账号配额限制；平台要求开通付费能力时应停止并由所有者决定。

不要重命名已有 Durable Object 类、迁移标签或数据实例名称来“修复部署”；这可能产生新的空数据空间。代码发布不等于现有数据迁移，不要删除旧库或覆盖正式用户数据。

## 一次性空库迁移工具

迁移凭据 `MIGRATION_TOKEN` 至少 43 字符随机值，需同时通过私有环境变量传给本地工具和 Worker secret。未配置时维护入口返回 404。工具不会把凭据打印出来。

```sh
# 在服务的 npm 项目目录执行；Foclo 需先 npm run build
node --env-file=.env cloudflare/migrate.mjs export data/cloudflare-backup.json
node --env-file=.env cloudflare/migrate.mjs import data/cloudflare-backup.json https://YOUR-WORKER.workers.dev
# 验证后立刻删除临时维护凭据
npx wrangler secret delete MIGRATION_TOKEN
```

导出不覆盖已有备份；导入检查 SHA-256、格式、schema、外键和表行数，只接受全空的目标库，成功后写入单次导入回执。再次导入或已有数据均拒绝，校验失败在事务中回滚，不做覆盖删除。备份含个人数据，应留在被忽略的 `data/`，不要上传到 GitHub。

## 本次迁移准备状态

本机 `.env` 指向的 PostgreSQL 端口当前未运行，导出尝试因连接被拒绝而未生成备份。没有启动旧服务、修改其数据或切换小程序地址。正式迁移仍需取得当前数据源的一致性新备份，不能以旧测试数据代替。
