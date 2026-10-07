# 未来 App 接入

复用 HTTPS /api/v1 和 PostgreSQL 业务模型，不调用微信云数据库，不直接连接业务库。App 实现本机事实存储、可恢复提交、固定账号/代次空间、outbox、影子版本、冲突副本与已完成计时同步；ACTIVE 与控制权仍设备本机。

身份验证作为 auth provider 新适配层。当前只有真实小程序 code 交换实现，未伪造 App 登录。小程序/App OpenID 不同；必须通过可信 UnionID 或显式双边账号绑定关联内部 userId，建立 provider/appId/subject 唯一约束，绑定操作要防账号接管。

每台安装生成 UUID deviceId。登录可携带 deviceId，服务端会存入 auth session；`sync/push` 和导入 commit 必须携带 deviceId，完成记录保留来源设备。操作 ID 离线生成 UUID，安全凭证由服务端随机生成并在 App 使用系统安全存储。access 默认 15 分钟、refresh 30 天、轮换宽限 30 秒；并发刷新由客户端单协调，响应持久化后再替换凭证。退出撤销会话但保留本机队列。

项目与 COMPLETED 记录必须提供 `createdAtSec`/`updatedAtSec` 整秒时间戳；运行中 ACTIVE 计时仍是设备本地状态。单条已完成记录（含暂停）上限 220 KiB，push 单请求最多 50 个操作且请求体最多 256 KiB。服务器版本/代次/序号使用十进制字符串。发送前持久冻结请求；未知结果重试相同 ID 与 payload。业务冲突用新操作 ID，在保全原资料后明确采用云端、重新提交、重命名/映射或新建归属。删除不复活，代次不匹配隔离旧空间。

拉取每页最多 100 条且序列化响应不超过 240 KiB；每个 snapshot/export 每页最多 50 条且同样受 240 KiB 上限约束。单个大于页上限的实体返回明确错误。快照按 space 最多 10 个未过期副本，保留 24 小时；导入任务最多 5 个活跃 job/space、7 天、每个 job 总计 8 MiB，单块最多 256 KiB，来源最多 500 项目与 10,000 条记录。导入预览后可用项目 `mapping`、会话 `sessionMapping`（目标 UUID 或 `skip`）解决冲突；响应分别给 source 与已应用 counts。拉取分页遵守签名游标和固定上界；全量快照从不可变 staging 读取，最后游标接续增量。恢复后的 restore_epoch 变化触发全量重建，保留未上传及冲突数据。事件时间为 epoch 整秒、UTC+8 统计；服务接收时间不替代用户历史。

参考 api.openapi.yaml、api-examples.md、deployment.md、backup-recovery.md 与 architecture-decisions.md。production 数据库需应用最小权限角色；migration 005 撤销 PUBLIC/anon/authenticated 的访问，不自动创建或授权应用角色。账号删除目前只有申请 endpoint 和隔离管理员 CLI fulfillment；正式保留政策与审批仍待确定，不应将其视作已上线的注销体验。协议变更增加版本和兼容策略；未知协议返回升级提示。App 身份绑定、页面、商店发布与跨设备接力计时不在本次实现范围。开发者工具模拟器已完成实际微信登录和本机首次同步，手机与公网验收仍未完成。
