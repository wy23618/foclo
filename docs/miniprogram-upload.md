# Foclo 微信小程序上传与验收

## 当前发布边界

Foclo 小程序前端由微信开发者工具上传和发布；GitHub Actions 自动部署 Cloudflare API，不会替你上传小程序。`D:\Projects\codex coding\Foclo` 是小程序的日常编辑目录，也是 `wy23618/foclo` 仓库的稀疏 Git 工作区，只显示小程序前端文件。项目 AppID 为 `wx6ed8386f53a1801b`。

小程序 API 已指向 `https://api.foclo.hellovian.com/api/v1`，微信 request 合法域名为 `https://api.foclo.hellovian.com`。Cloudflare Worker 已就绪，原 PostgreSQL 数据已迁移到 `FOCLO_DB` Durable Object；16 张业务表、账号身份、项目与专注记录、同步回执及删除标记均已核对。旧 PostgreSQL 和加密备份保留在原服务器作为回退来源。迁移详情及回退约束见 [Cloudflare 部署与迁移说明](CLOUDFLARE.md)。

## 上传步骤

以后只在 `Foclo` 目录修改小程序代码。该目录直接连接 GitHub 上的同一个仓库，不需要再生成第二份上传目录。修改后在 `Foclo` 目录运行：

```sh
git add .
git commit -m "描述本次修改"
git push origin main
```

改代码前可在同一目录运行 `git pull --ff-only` 获取 GitHub 最新版本。`Foclo` 工作区只包含小程序文件；服务器、测试与运维文件仍保留在完整开发仓库及 GitHub 中。项目配置会在微信上传时排除 Git 元数据和非小程序目录。

`git push` 会触发 GitHub Actions 验证并部署 Cloudflare API。要发布小程序，还需在当前 `Foclo` 开发者工具窗口编译检查，然后由项目所有者点击“上传”。这一步不会自动发生。

1. 在微信开发者工具中选择名称为 Foclo 的独立上传项目，确认 AppID 与上方一致。
2. 编译并检查首页、统计页和账号/同步状态页没有运行错误。
3. 点击右上角“上传”，填写本次版本号和简短版本说明后提交。
4. 在微信公众平台按需要设置为体验版、提交审核或发布。上传代码本身不会自动公开发布。

仓库当前 103 项小程序自动化测试已通过。上传前可在仓库根目录重新运行：

```sh
node --test tests/*.test.js
```

## 上传后的真实设备验收

用原有微信账号打开上传后的体验版本，依次确认登录成功、能读取迁移前已有的项目和专注记录、同步状态正常。再创建一个明确标记为测试用途的项目和专注记录，验证读取、修改、删除及再次同步；不要清空账号或删除原有真实数据。发生失败时记录页面提示和大致时间，先检查 Cloudflare API 健康状态与同步状态，不要重复导入迁移数据。

当前线上 API 检查地址：[`https://api.foclo.hellovian.com/health/ready`](https://api.foclo.hellovian.com/health/ready)。预期为 HTTP 200 且 `storage` 显示 `durable-object-sqlite`。迁移后的真实账号数据检查必须在微信客户端完成，网页健康检查不能代替登录或数据验收。

## 回退说明

微信版本可按微信平台的版本管理流程回退。后端旧 PostgreSQL 仍保留，但 Cloudflare 接收新写入后，不能直接启动旧服务切回，否则会遗漏新数据；必须先对新增数据做反向迁移并核对，再恢复旧服务。不要删除旧数据库或迁移备份。
