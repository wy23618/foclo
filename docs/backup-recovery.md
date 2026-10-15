# 备份、恢复与账号注销处理

## 本机资料

旧 yotick/* 原副本和逐键 yotick-legacy-snapshot/* 保留。升级标记未完成时重新启动续传，不手工删除标记或旧键。账号事实按 spaceId、generation、本机缓存代次隔离；清空云端或更换缓存视图保留旧视图，通过“导出历史空间副本”取得恢复资料。

本机普通备份继续 formatVersion=1。账号恢复副本 formatVersion=2，包含 localBackup（v1）及 syncRecovery（队列、影子、回执、冲突、迁移与恢复资料）。恢复到当前空间时事实走正常业务提交及 outbox；同步资料仅保留为恢复档案，不直接复活旧队列或覆盖当前凭证/代次。备份合并单次安全限制仍为 650 KiB，超限明确拒绝并保留原数据；大资料使用分块游客迁移，不能承诺大备份在小程序中已无限量恢复。

冲突采用云端前保存本地事实和相关任务。删除后的记录必须明确选择有效项目或另建项目；另存时生成新记录/暂停 ID，原资料保存在恢复区。未上传内容或冲突存在时禁止清缓存。不要先删 outbox 再恢复快照。

当前页面的“重建本机账号资料”使用新缓存代次重新下载，旧副本仍可恢复导出，**不释放旧副本占用空间**；不能把它用于解决文件容量不足。历史视图/游客副本没有自动删除。单次迁移完成后新增的游客资料可再次显式迁移，前次映射另存 import-history，不覆盖原迁移结果。

## 数据库

正式环境使用托管数据库备份或 pg_dump/pg_restore，备份整个业务 schema，必须包括 schema_migrations 的当前版本，以及 users、身份、认证会话及 device_id、projects、study_sessions、pauses、偏好、操作回执、变更日志、空间代次、迁移任务与快照。暂停明细存放在 `pauses` 表。当前部署 schema 版本为 5；恢复服务前确认版本至少为 5。TOKEN_PEPPER/CURSOR_SECRET 由密钥管理单独保存，备份密码与数据库权限分离。备份中包含个人事实与凭证哈希/加密刷新回放，因此必须限制访问并加密。005 会撤销 PUBLIC 与 anon/authenticated 的表权限；应用业务角色必须通过独立、最小权限授权才能运行。

恢复到全新隔离库，禁止直接覆盖正在使用的正式库。恢复所有相关表后，在切换服务前执行 UPDATE spaces SET restore_epoch=gen_random_uuid()，让旧游标返回 CURSOR_EXPIRED，客户端保全待上传资料后全量恢复。不能只恢复项目与记录却丢弃回执。正式恢复需要停止写入、核对恢复点、运行验收，再决定切换。

本机已实施真实 PostgreSQL 逻辑备份恢复演练：backup.ts 在 REPEATABLE READ 中读取明确白名单事实表；JSON 编解码后恢复到新建测试数据库，校验表数量及旧游标隔离。该工具拒绝非空目标并校验 schema。它不导出 schema_migrations，也不代替正式库整库备份或托管平台的备份/回档验收。

2026-10-08 另已使用本机PostgreSQL17客户端，对当前测试资料的pg_dump自定义格式备份执行真实pg_restore。server/local-dev/verify-dump-restore.mjs仅接受本机127.0.0.1:5433的专用集群、私有backups目录下的归档；创建唯一隔离库，撤销PUBLIC及业务/迁移角色连接权，不覆盖现存数据库。对归档与恢复库逐表比较COPY列、排序后的行数和SHA256摘要，17张表完全一致，包括schema_migrations；随后仅在隔离库更新restore_epoch，旧游标被拒绝。证据是私有yotick_restore_drill_4fb05f09e2db.json，恢复库保留供复查。运行方式：在server目录使用`node --env-file=.env local-dev/verify-dump-restore.mjs <备份文件名.dump>`。没有切换真实服务的数据库，没有执行云平台恢复。

当前运行规则与正式默认预案见operations-policy.md：本机加密日备份、不自动清理联调证据；正式拟采用30天滚动保留、RPO24小时/RTO4小时，但异地、到期清理和云恢复仍未实施或测量，不能承诺已达成。新AES-256-GCM归档与自动后台首份归档均完成17表隔离恢复验收。

## 注销流程

新增独立批准删除记录与旧备份恢复门禁，见[注销恢复保护](deletion-ledger.md)。管理员CLI现在必须设置受保护的 `DELETION_LEDGER_DIRECTORY`；缺失或损坏时拒绝删除。批准记录在业务删除事务提交前持久化，事务失败后仍保留待重试批准。隔离恢复后必须用最新完整独立记录执行reconcile，再核对restore_epoch和验收，不能只恢复数据库就上线。云端已有空记录目录与门禁，持续异地复制/外部最新性和正式运营流程仍未具备。

客户端显式提交 `/api/v1/account/deletion-requests`；这只登记 `pending_policy_review` 申请，不是注销成功。管理员核实正式数据保留政策、申请人身份与授权后，可在隔离管理环境使用 `MIGRATION_DATABASE_URL` 执行 `npm run fulfill-deletion -- <request-id>`，并通过受保护环境设置 `ACCOUNT_DELETION_CONFIRM` 为完全相同的 request ID。CLI 再次核对指定申请仍待审，并在事务内撤销会话、清理刷新回放、所有账号事实、身份、空间及申请资料；它不提供批量或任意 userId 删除，不影响其他用户。

该命令会不可恢复地删除目标账号真实资料；真实调用需用户/运营授权与正式流程，开发期间只对生成样本测试。正式政策、审批角色、处理时限、用户告知、备份中到期清理与审计要求都尚待配置，属于发布前阻断项；当前没有真实请求获批或真实删除执行。新登录不能按昵称、输入手机号或不同 App OpenID 自动找回原账号。
