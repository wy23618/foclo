# Foclo 微信小程序上传与验收

## 当前发布边界

Foclo 小程序前端由微信开发者工具上传和发布；GitHub Actions 只自动部署 Cloudflare API，不会替你上传小程序。当前源码在本仓库根目录，项目 AppID 为 `wx6ed8386f53a1801b`。请在微信开发者工具中选择名称为 **Foclo** 的当前项目。

小程序 API 已指向 `https://api.foclo.hellovian.com/api/v1`，微信 request 合法域名为 `https://api.foclo.hellovian.com`。Cloudflare Worker 已就绪，原 PostgreSQL 数据已迁移到 `FOCLO_DB` Durable Object；16 张业务表、账号身份、项目与专注记录、同步回执及删除标记均已核对。旧 PostgreSQL 和加密备份保留在原服务器作为回退来源。迁移详情及回退约束见 [Cloudflare 部署与迁移说明](CLOUDFLARE.md)。

## 上传步骤

1. 在微信开发者工具中打开本仓库根目录，确认项目名称为 Foclo、AppID 与上方一致。
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
