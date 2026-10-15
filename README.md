# Foclo

**专注当下，也看见长期投入。** 一款原生微信小程序，提供专注计时、项目管理、学习记录和统计。代码保留了早期名称 YoTick；小程序前端由微信平台发布，线上 API 使用 Cloudflare Workers。

## 核心功能

- 离线计时、暂停和休息，完成记录后进入同步队列，网络不阻塞计时。
- 分层项目、归档与恢复、记录管理，按天、项目及时间段查看投入。
- 日历热力图、学习时间线、统计图与主题设置。
- 微信登录、访客与账号空间隔离，以及符合现有策略的访客记录合并。
- 带版本检查、幂等操作、分页游标和恢复快照的增量同步。
- 数据导出、隐私说明与账号注销申请；正式数据删除有独立审查流程。

## 体验与演示

使用微信开发者工具导入项目，或访问由所有者发布的微信小程序版本。当前仓库没有公开体验码；[演示素材目录](docs/media/README.md) 记录截图与体验码位置。

API 默认部署地址规划为 `https://foclo-api.hellovian.workers.dev`。实际上线、微信 request 合法域名及真机验证状态见 [Cloudflare 指南](docs/CLOUDFLARE.md)。网页访问 API 不会展示小程序 UI。

## 本地开发

需要微信开发者工具与 Node.js 24 LTS。前端使用原生 JavaScript / WXML / WXSS，无需 npm 构建。

1. 克隆仓库，用微信开发者工具导入根目录。
2. 在 `project.config.json` 配置自己的 AppID。AppID 是公开标识，AppSecret 只能留在后端 secrets。
3. 后端地址由 `sync/config.js` 管理；正式发布前须配置已验证的 HTTPS 地址与微信 request 合法域名。

前端回归测试：

```sh
node --test tests/*.test.js
```

Cloudflare API 开发与验收：

```sh
cd server
npm ci
# 复制 .dev.vars.example 为 .dev.vars，填写自己的配置
npm run dev:cloudflare
npm run build
npm run test:cloudflare
```

真实 `.dev.vars`、`.env`、数据库、备份和微信个人配置均不进入 Git。

## 技术栈与结构

微信原生小程序 · JavaScript · TypeScript · Node.js 测试工具 · Cloudflare Workers · SQLite Durable Objects

```text
pages/               专注、项目、记录、统计、账号与设置页面
components/          小程序组件
core/                计时、项目、记录与统计领域逻辑
storage/             本地持久化与账号空间
sync/                登录、队列、冲突、快照与迁移
utils/ themes/       显示工具与主题
tests/              小程序回归测试
server/src/          认证、同步、导入与协议逻辑
server/cloudflare/   Fetch 路由、SQLite 适配、云端 schema 与运行时验收
server/migrations/   原 PostgreSQL schema 留档
docs/               API、设计、验收与部署指南
```

## Cloudflare 部署

后端复用现有认证和同步服务，通过 Fetch 路由与 SQL 适配运行于 Workers；SQLite Durable Object 提供持久化、串行请求处理与事务。不需要 VPS、常驻 Node 进程或外部 PostgreSQL。

```sh
cd server
npx wrangler secret put WECHAT_APP_ID
npx wrangler secret put WECHAT_APP_SECRET
npx wrangler secret put TOKEN_PEPPER
npx wrangler secret put CURSOR_SECRET
npm run deploy
```

`TOKEN_PEPPER` 与 `CURSOR_SECRET` 必须是独立的至少 32 字符随机值。旧系统迁移须保留密钥并单独迁移数据，不应将正式客户端直接指向空库。未配置完成的 API 返回 503。

GitHub `main` 推送后先运行小程序及后端验收，再由 GitHub Actions 部署 Cloudflare。需要仓库 secrets `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。小程序前端仍需按微信流程上传、审核、发布；Git push 不会绕过微信审核。

旧 PostgreSQL / Linux 运维脚本作为历史兼容资料保留，长期主流程见 [Cloudflare 指南](docs/CLOUDFLARE.md)。

## 日常更新

```sh
git add .
git commit -m "Describe the change"
git push
```

后端从 `main` 自动更新，构建失败阻止发布。前端更新后在微信开发者工具完成真机验收并按微信流程发布。

## Roadmap

- [x] 离线计时、项目、记录与学习统计
- [x] 微信认证、账号隔离、同步与冲突恢复
- [x] Cloudflare 后端适配及隔离运行时验收
- [ ] 完成首次 Cloudflare 发布、数据迁移与微信端连接验收
- [ ] 补充公开截图、体验码与上手演示
- [ ] 改善跨设备恢复提示与长期备份运维

反馈请提供设备、基础库版本和复现步骤，勿附带真实学习数据库、登录令牌或 AppSecret。安全问题见 [SECURITY.md](SECURITY.md)。
