# 账号与同步设计决策

## ADR 001：事实与提交边界

保留 core/service 的命令串行队列、epoch 整秒、UTC+8 和本地计时算法。可靠提交内同时写业务事实和 outbox；自动结算也进入同一入口。savePrefs 改用可靠提交。网络 worker 永不成为计时命令等待项。

## ADR 002：本地隔离与升级

每个游客/账号空间固定 adapter，逻辑 yotick/* 键映射到物理空间前缀。先恢复旧提交、校验并保存原始副本，再逐键复制与验证，最后写激活标记。保留旧副本。全局配置/凭证不属于空间清空范围。切换禁止活动专注/休息，旧 worker 的固定 adapter 加切换代次防止响应串号。

## ADR 003：协议与版本

API /api/v1，protocolVersion=1。spaceId 不构成授权；服务端从凭证查所属用户。generation、serverVersion、seq 为十进制字符串。本机 revision/dataRevision 只在本机使用。每次空间写事务先锁 spaces；事实、暂停、changeSeq、日志、回执一并提交。操作摘要按规范化 JSON 计算。永久回执/tombstone 不自动清理。

project.create/patch/reorder/archive/restore/deleteSubtree，session.createCompleted/delete，prefs.patch。项目组操作包含 expectedVersions，校验完整相关组后原子执行。create 服务端分配稳定排序号；reorder 携带完整同级顺序。patch 仅名称、颜色、简称；父子关系由 create 确定。lastUsedAtSec 不同步，避免计时开始产生项目冲突。

## ADR 004：连续离线修改与冲突

同实体或项目组操作串行依赖；发送前持久冻结请求和基准版本，响应丢失仍用同 ID/摘要。确认只更新影子；存在后续本地任务时不覆盖事实。拉取先保存影子及冲突副本，再推进游标。删除不复活。活动项目删除保留隔离上下文；完成记录由用户明确重新归属。清空代次不匹配隔离整个旧队列与事实，用户导出/恢复后才能重新提交。

## ADR 005：分页、快照与迁移

分页游标签名绑定空间/代次/协议和固定上界。快照物化保存不可变分页数据及截止序号。迁移采用不可见分块 staging、摘要与稳定源快照，显式项目映射，最终原子发布；任务限制字节/实体数/寿命，超限真实报错。备份 v1 兼容，账号导入走普通 outbox，不绕过 tombstone。

## 字段归属

同步：项目 id/name/parentId/creationOrder（服务器规范化）/archived/shortName/color；COMPLETED 记录与全部暂停。颜色旧分配在创建/迁移时固化为项目字段。

账号偏好白名单：startupMode/defaultMinutes/commonMinutes/confirmEnd/dailyGoalEnabled/dailyGoalMinutes/weekStartsSunday/restEnabled/shortBreakMinutes/longBreakMinutes/longBreakEvery。新增字段默认本机。

本机：ACTIVE、theme/lightTheme、常亮、statsPreset/timeSlotScaleMinutes、lastProjectId/lastStartMode、休息与轮次、欢迎标记、索引/缓存。项目删除清理 lastProjectId。

## 运行时

## ADR 006：容量与全量视图

空间事实、队列、影子、日志及升级副本使用 USER_DATA_PATH 文件层；少量同步 UI 状态和全局凭证保留键值存储。文件先写临时文件，再重命名替换；失败交给原可靠提交重放，不将损坏文件当成空值。96 MiB 是应用预算而非平台配额保证；真实底层容量不足仍报错，临时替换空间也计入预算。旧版命名空间键值副本仅在文件替换成功后移除，原始未分区数据继续保留。

全量快照分页先保存 staging。构建在业务队列外运行，本地命令继续提交；最终在队列内比较捕获的本地提交代数，资料变更则清理此次不可见视图、保留下载页并重新构建。新事实/索引视图完成后，仅在小型可靠提交中切换事实指针、冲突标记和游标；崩溃只能看到旧完整视图或新完整视图。历史视图支持只读导出，不重放共享队列，不自动清理。容量不足阻止切换，保全原事实。

无云端变更的开始/暂停/恢复不扫描待上传队列；只读同步状态不反复重载事实。大规模删除的回执数据库保留完整效果，传输确认按字节截取并标记 hasMoreChanges，worker 先拉完变更再发送下一任务。真机文件容量、耗时及帧表现仍待测量。

当前运行架构（由ADR 007替代早期草案）：Node 24 LTS + TypeScript + Fastify 5 + pg，标准 PostgreSQL。用户后续明确选择自有阿里云 ECS；后端和 PostgreSQL 已部署在同一主机，数据库保持本机监听，公网接入待域名/备案条件到位。小程序使用 wx.request HTTPS，正式环境禁止测试身份。普通运行账号与迁移账号分离，TLS 不关闭证书校验。

参考：[Node 支持周期](https://github.com/nodejs/Release)、[Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)。后续云资源计费和容量按控制台与实际负载核实。

## ADR 007：从 CloudBase 暂定方案切换到自有 ECS

后续内部测试更新（2026-10-09）：用户准备上传为体验版。允许手机develop/trial使用既有临时IP HTTPS并尝试开启调试，仅供有限成员内部测试。正式release仍不选择该入口，且请求层拒绝明确指定临时入口的正式/未知环境；不放开trial HTTP。该方案基于腾讯网络/调试说明，真实微信trial仍须上传后手机验收，不能宣称合法域名配置或正式上线已完成。详见[体验测试说明](trial-testing.md)。

日期：2026-10-08。用户明确选择先用本人领取的阿里云 ECS 自建通用后端，不依赖 CloudBase。采用 Ubuntu 22.04、Node 24、PostgreSQL 17；业务 API 和数据库只监听回环地址，由 systemd 管理。选择理由是以标准 Node/PostgreSQL 保留迁移自由，并在现有试用资源上完成内部部署。此选择不代表免费试用满足中国大陆备案条件，也不代表已完成小程序公网链路。用户确认当前没有域名；试用 ECS 控制台显示按量付费。正式微信公网请求需合格域名、备案、有效 HTTPS 和小程序请求域名配置。云端数据库现有内容是测试快照。

2026-10-08 冲突展示细化：冻结上传被拒绝后，后续拉取必须把未处理冲突的cloud更新为权威影子最新版本，同时保留cloudAtConflict和本地原提议。已持久化resolving/resolutionChanges的明确选择不随后台拉取改变。旧客户端已经推进游标却留下过期cloud的条目可在空增量页中修正；不要求删除队列、冲突或清空空间。

2026-10-08 文件读取性能细化：DevTools实际万条资料显示串行stat/会话读取耗时较高。索引扫描与范围会话读取改用最多8个并行原生读取，保持输入/文件键顺序；每批全部结束后才传播失败，不启动失败之后的批次，避免失败查询离开串行服务队列后仍有悬挂读取。目录递归前先flush文件批次；完整扫描成功前不发布新容量索引。没有改变可靠提交、写入串行、队列、凭证或游标。数量8是当前保守并发上限，不能据电脑改善宣称手机帧表现通过。
