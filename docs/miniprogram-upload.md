# Foclo 微信小程序上传与验收

## 当前发布边界

Foclo 小程序前端由微信开发者工具上传和发布；GitHub Actions 自动部署 Cloudflare API，不会替你上传小程序。`D:\Projects\codex coding\Foclo` 是唯一日常编辑目录，也是 `wy23618/foclo` 的完整 Git 工作区。微信项目配置会在上传时排除 `.git`、后端、测试、文档和 GitHub 工作流等非小程序内容。项目 AppID 为 `wx6ed8386f53a1801b`。

小程序 API 已指向 `https://api.foclo.hellovian.com/api/v1`，微信 request 合法域名为 `https://api.foclo.hellovian.com`。Cloudflare Worker 已就绪，原 PostgreSQL 数据已迁移到 `FOCLO_DB` Durable Object；16 张业务表、账号身份、项目与专注记录、同步回执及删除标记均已核对。旧 PostgreSQL 和加密备份保留在原服务器作为回退来源。迁移详情及回退约束见 [Cloudflare 部署与迁移说明](CLOUDFLARE.md)。

## 上传步骤

以后只在 `Foclo` 目录修改代码。该目录同时包含小程序前端和 API 后端，直接连接 GitHub 上的同一个仓库；微信开发者工具也直接打开这个目录，不需要生成或维护第二份上传目录。修改后在 `Foclo` 目录运行：

```sh
git add .
git commit -m "描述本次修改"
git push origin main
```

开始修改前可在同一目录运行 `git pull --ff-only` 获取 GitHub 最新版本。微信上传只会包含项目配置指定的小程序文件；完整仓库中的服务器、测试、文档和运维文件仍正常参与 Git 版本管理，但不会进入小程序包。

`git push` 会触发 GitHub Actions 验证并部署 Cloudflare API。要发布小程序，还需在当前 `Foclo` 开发者工具窗口编译检查，然后由项目所有者点击“上传”。这一步不会自动发生。

1. 在微信开发者工具中选择名称为 Foclo 的独立上传项目，确认 AppID 与上方一致。
2. 编译并检查首页、统计页和账号/同步状态页没有运行错误。
3. 点击右上角“上传”，填写本次版本号和简短版本说明后提交。
4. 在微信公众平台按需要设置为体验版、提交审核或发布。上传代码本身不会自动公开发布。

2026-10-26 验收：186 项小程序自动化测试、32 项后端测试及 Cloudflare 运行测试通过。上传前可在仓库根目录重新运行：

```sh
node --test tests/*.test.js
```

## 上传后的真实设备验收

2026-10-26 已通过本机微信开发者工具 CLI 成功上传开发版本 `1.0.20261026`，包大小 1,113,067 字节。上传内容包含同步修复、刷新记录、跨设备近期计时提醒及按实际状态区分的提示文案；首页不常驻显示检测限制。后端已部署至 Cloudflare，版本 ID 为 `1bb5160f-1ad1-4c46-ad46-e75486022fb6`；健康检查 200，已登录客户端的计时状态检查返回 available=true。本次没有提交微信审核或发布正式版。上传回执保存在本机受限运维目录，不进入仓库。

用原有微信账号打开上传后的体验版本，依次确认登录成功、能读取迁移前已有的项目和专注记录、同步状态正常。再创建一个明确标记为测试用途的项目和专注记录，验证读取、修改、删除及再次同步；不要清空账号或删除原有真实数据。发生失败时记录页面提示和大致时间，先检查 Cloudflare API 健康状态与同步状态，不要重复导入迁移数据。

当前线上 API 检查地址：[`https://api.foclo.hellovian.com/health/ready`](https://api.foclo.hellovian.com/health/ready)。预期为 HTTP 200 且 `storage` 显示 `durable-object-sqlite`。迁移后的真实账号数据检查必须在微信客户端完成，网页健康检查不能代替登录或数据验收。

## 回退说明

微信版本可按微信平台的版本管理流程回退。后端旧 PostgreSQL 仍保留，但 Cloudflare 接收新写入后，不能直接启动旧服务切回，否则会遗漏新数据；必须先对新增数据做反向迁移并核对，再恢复旧服务。不要删除旧数据库或迁移备份。
