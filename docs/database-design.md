# PostgreSQL 数据模型

以 server/migrations/001–005 的 SQL 为可执行定义。所有业务读写只能由 HTTPS 后端进入；005 撤销 PUBLIC 与已存在 anon/authenticated 角色的业务表权限。业务角色与迁移管理员分离，生产连接强制验证 TLS 证书。

| 表 | 主键及职责 |
| --- | --- |
| users、auth_identities | 用户 UUID；(provider, app_id, subject) 唯一绑定身份，不将客户端提交的 openid 当凭证 |
| spaces | 用户唯一私人空间；generation、change_seq、next_order、restore_epoch |
| projects | (space_id,id)；同空间父子外键、排序、JSON 规范事实、server_version、deleted_at |
| study_sessions、pauses | 同空间 UUID；记录引用项目，暂停引用记录；完成事实不可修改，删除保留 tombstone |
| account_preferences | 每空间一份白名单偏好及版本 |
| sync_operations | (space_id,generation,operation_id)；规范请求摘要和永久回执 |
| sync_changes | (space_id,generation,seq)；版本、删除标记、规范事实 |
| sync_snapshots、snapshot_items | 不可变导出/快照，固定 upper_seq、代次、恢复纪元和到期时间；序号分页 |
| import_jobs、import_items | 不可见迁移 staging；分块摘要、明确映射和原子发布结果 |
| auth_sessions、refresh_token_history | 哈希访问/刷新凭证、设备 UUID、家族撤销；短期加密重试结果 |
| account_deletion_requests | 注销申请与行政执行结果，不将申请成功等同立即删除 |

版本、代次及序号通过 API 传十进制字符串，避免 JavaScript 精度丢失。本机 revision 不进入服务端 CAS。spaces 行锁在每次业务写事务开始取得；分配序号、事实/暂停、版本、变更日志、回执在同一事务提交。多操作请求使用 savepoint，业务冲突保存永久回执，可重试错误不保存失败回执。

项目排序/归档/恢复/子树删除先检查完整相关组的 expectedVersions；任何一个不符都整组回滚。删除不物理移除 UUID 或回执，旧创建请求不能复活。清空增加 generation，保留清空回执，旧设备不能向新代次提交。备份恢复更换 restore_epoch，旧游标转为全量恢复而非跨过缺失变化。

分页事务为 REPEATABLE READ，游标签名绑定空间/代次/协议/固定上界/恢复纪元。快照物化在一致事务内完成；分页期间写入只能进入后续增量。大子树回执在传输中截取，剩余事实仍完整留在日志及数据库。

日志、tombstone、回执的保留策略尚未正式批准，当前不自动压缩或删除。临时快照/迁移任务有到期拒绝和数量限制；生产到期清理、监控与容量阈值需在测试环境演练后配置。数据库恢复和注销 CLI 仅对生成的本机样本执行过，真实数据操作另需安全配置及相应授权。
