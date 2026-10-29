# 2026-10-29 功能与部署核对

用户反馈此前功能可能未部署，重点复查刷新。以下区分实际部署证据与本地功能验证。

## 已有服务端部署

- GitHub `main` 在本次核查时为 `77053f33b85aea6f713c4ad6e70f39d258eb8f30`，与当前后端源码一致。
- [部署任务 40319876627](https://github.com/wy23618/foclo/actions/runs/40319876627) 的 `Deploy API` 步骤成功，日志记录 Worker 版本 `b882e368-d5b3-450a-9319-4ae0340ab7e7`。
- 该提交已包含跨设备计时状态接口、对应 schema 与测试。线上 `/health/ready` 返回 200 与 `durable-object-sqlite`；未认证访问 `GET /api/v1/sync/pull`、`POST /api/v1/sync/push` 和 `POST /api/v1/focus/presence` 均返回 401 `AUTH_REQUIRED`，证明路由已存在，不把鉴权失败当作路由缺失。
- 上述检查没有向真实账号写入测试数据；接口存在不等于所有手机均完成更新或通过全部真实设备验收。

## 刷新核查与修正

刷新不需要新增服务端“刷新”接口：客户端等待既有同步任务完成，再执行新一轮上传与拉取，最后重读本机投影和每日明细。新按钮、反馈和调度位于小程序客户端，必须更新微信小程序包才能获得。

本次补齐平台请求不回调时的 15 秒超时退出、账号切换时直接结束等待、同步后页面/明细读取失败不误报成功，以及项目统计和当天统计的下拉刷新。测试覆盖超时、迟到响应、重试、取消、云端下载后刷新顺序、后台周期完成后的新一轮拉取、双设备记录收敛与账户隔离。

本地结果：小程序 235 项、后端 32 项、Cloudflare Worker 运行测试 1 项通过，后端 TypeScript 构建通过。未通过桌面界面执行操作，未向真实账号写入测试资料。

发布流程仍为：本地验证后提交并推送代码，等待 GitHub Actions 的 `Deploy API` 成功，再核对线上健康与接口；小程序另行通过微信 CLI 上传。最新流水线、提交号和上传回执以各自成功结果为准。

## 本次发布结果

- 完整功能代码已推送为 `9b1d7d1a5fa933e87492d4fda02ab80a277b5e10`。[流水线 40898862653](https://github.com/wy23618/foclo/actions/runs/40898862653) 的前端、后端、Worker 检查及 `Deploy API` 均成功。
- Cloudflare Worker 发布版本：`09b5da92-f30b-4ea1-830c-98b510a87ba9`。部署后的 `/health/ready` 返回 200，存储为 `durable-object-sqlite`。
- 微信开发版 `1.0.20261029.1` 已成功上传，包大小 1,159,287 字节，包含本次刷新修复。首次上传因本机代理端口拒绝连接失败，代理恢复后重试成功；未更改系统代理配置。
- 上传回执 `C:/Users/Wenyang/AppData/Local/YoTick/LocalServer/upload-1.0.20261029.1.json`；两端发布汇总 `C:/Users/Wenyang/AppData/Local/YoTick/LocalServer/release-20261029-refresh.json`，均留在本机运维目录。
- 本次没有提交微信审核或发布正式版，手机正式版不会仅因服务器部署而自动获得新的刷新入口。
