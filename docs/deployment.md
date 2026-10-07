# 部署与运行准备

更新日期：2026-10-07。当前已完成本机开发、自动化测试和模拟/双客户端协议验证，并在微信开发者工具模拟器完成真实微信登录与本机首次同步。手机/真机验收尚未完成。未开通、部署或修改任何真实云资源，未公开发布。

## 选型与已核实能力

CloudBase 云托管运行通用 Node 24 / Fastify 后端，pg 标准协议连接 PostgreSQL。官方文档说明[云托管公网入口支持 HTTPS 与小程序/App](https://docs.cloudbase.net/run/deploy/service-setting)，[PostgreSQL 标准协议适合后端事务和连接池](https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql)。当前账号、地域、配额和实际连接地址尚未核实。没有改用文档数据库或客户端直连。

官方 PostgreSQL 示例包含关闭证书校验的写法；本项目不采用。production 强制 TLS，系统信任或 DATABASE_CA 配置 CA，rejectUnauthorized=true。连接 URL 不得附带 sslmode=no-verify 或覆盖 TLS 配置。

## 本地运行

在 server 目录使用 Node 24，运行 npm ci、npm run build。将 .env.example 复制到受保护、被打包排除的 .env，通过环境变量载入；不要把密钥放入 sync/config.js。启动使用 node --env-file=.env dist/src/index.js。

迁移使用独立 MIGRATION_DATABASE_URL，业务使用 DATABASE_URL。执行 npm run migrate 前确认目标环境和数据库；迁移 runner 跳过 schema_migrations 中已有版本，当前迁移为 001–005。005 从 PUBLIC 以及存在的 anon/authenticated 角色撤销所有业务表权限；它不会替部署者创建业务角色或授权。管理员需单独授予应用角色连接权限、public schema USAGE、schema_migrations SELECT 和业务表所需的 SELECT/INSERT/UPDATE/DELETE；不给运行角色 CREATE/DROP 或管理员权限。迁移账号由管理人员掌握，运行容器不必持有可用迁移凭证（配置仍要求 MIGRATION_DATABASE_URL，可填不可用占位连接；迁移只在独立任务运行）。迁移 004 增加 `auth_sessions.device_id`，由登录请求可选的 UUID 写入。

用户选择先使用个人电脑作开发服务器。完整启动、停止和限制说明见 [local-server.md](local-server.md)。Windows 本机脚本使用单独的 PostgreSQL 数据目录，不接触现有数据库服务；API 与数据库只绑定回环地址，不开放局域网或公网。此本机实例适合模拟器和集成调试，不等同于外网服务器；手机、外网或正式小程序需 HTTPS 地址和微信合法域名。

管理命令现在直接运行编译后的 JavaScript：先构建，再运行 `npm run migrate` 或 `npm run fulfill-deletion -- <request-id>`；不依赖生产镜像中不存在的 tsx。需要本机 .env 时，可在 server 目录运行 `node --env-file=.env dist/src/migrate.js`，不要误认为 npm 自动载入 .env。迁移按数据库会话持有 advisory lock，两次并发启动不会重复执行同一 SQL；单个文件失败会回滚并释放锁，下一次可续跑。真实 PG 的并发/重复/失败回滚及已编译 CLI 已覆盖专项测试。

`server/deploy/permissions.sql` 是部署授权脚本，不是自动 schema 迁移。管理员先在目标独立数据库安全创建非管理员 `yotick_app` 角色及登录秘密，再执行该脚本；它不含密码，不创建收费资源。脚本仅授予 schema_migrations 读取与业务表 DML，拒绝管理员属性、业务表拥有权或继承的 schema CREATE。角色成员关系、数据库 CONNECT、托管平台权限仍需实际复查；不要将应用角色设成数据库/表拥有者。生成的本地 PG 样本已验证业务读写可用，schema 更改和匿名事实读取被拒绝。

Docker 可用时，在 server 目录构建镜像。Dockerfile 使用多阶段构建及非 root 用户，端口默认 3000。`/health/live` 只检查进程；`/health/ready` 查询 schema_migrations，并要求迁移版本至少为 5，同时可访问数据库。当前本机没有 Docker，镜像构建与实际启动仍待验证。compose.yaml 仅供本地数据库，密码来自 local-postgres-password.txt（已忽略）；不得用于公网生产。

自动化验证：根目录 node --test tests/*.test.js；server 目录 npm test、npm run build。Windows 测试会将 PostgreSQL 原生二进制复制到 ASCII 临时路径，避免中文安装路径的编码失败；只绑定 127.0.0.1。真实库事务测试不使用内存 SQL 替身。测试留下的临时簇只含生成的样本，保留以便诊断。

## 测试云端部署步骤

1. 在已授权测试环境确认 CloudBase 云托管与 PostgreSQL 地域、标准连接权限、VPC/内网路径、TLS CA 与最大连接数。
2. 创建迁移与业务角色，执行迁移，再注入业务环境变量。测试与正式库、AppSecret、TOKEN_PEPPER 和 CURSOR_SECRET 分开。
3. 部署镜像，设置 HOST=0.0.0.0、PORT=3000，检查两个健康入口。为业务实例配置扩容上限；实例上限 × DB_POOL_MAX 加管理余量必须低于数据库上限。
4. 开通测试 HTTPS 入口并配置网关限流、请求大小、访问日志脱敏和告警。wx.request 使用普通 HTTPS；sync/config.js 只填公开地址（带 /api/v1）。微信后台添加合法请求域名，真机不依赖开发者工具的忽略校验选项。
5. 配置微信 AppID/AppSecret 与合法请求域名后，用真实 wx.login 验证 code 交换、刷新、退出、设备会话与账号隔离，然后两台真机执行验收矩阵。2026-10-07 已在开发者工具模拟器完成真实微信登录与本机首次同步；手机、公网和两台真机验收尚未完成。生产环境没有身份替身开关。
6. 测量冷启动、慢网、数据库唤醒与本地计时；调整常驻实例前确认费用。平台域名用于测试，正式自有域名与备案要求按实际地域核实。

管理员处理注销申请使用 `npm run fulfill-deletion -- <request-id>`，隔离环境必须以 MIGRATION_DATABASE_URL 连接并将 ACCOUNT_DELETION_CONFIRM 安全设为同一 request ID。该步骤永久删除资料；正式保留政策、申请人核验、审批角色与授权流程确定前，不得运行真实申请。

## 配置缺口

当前本机环境已自动生成独立 TOKEN_PEPPER、CURSOR_SECRET 与数据库密码，保存在受保护的本地文件；2026-10-07 用户已安全填写 `WECHAT_APP_SECRET`，服务已重启载入，并完成开发者工具模拟器登录与首次同步。若继续自有服务器路线，手机和外网验收还需要一台具备公网可达性的主机、HTTPS 域名与微信合法域名，以及两台真机。CloudBase 环境/地域/套餐只在之后改选 CloudBase 时才需要配置。秘密只通过云端密钥配置或本机受保护环境文件提供，不在聊天粘贴。还需要正式隐私政策、账号注销处理与备份保留政策；删除申请已有隔离管理 CLI，但实际删除必须等保留政策、审批责任与授权确定。

已有一次性配置询问，但本地工作继续推进。未获授权开通收费资源、购买域名或正式公开发布。

2026-10-06 实际控制台复核：现有 `cloud1` 显示传统集合数据库（当前可见集合包括 `focusSessions`、`focusStates`、`projects`、`users`）。顶部环境菜单中的“创建新环境”打开个人版表单，显示 ¥19.9（原价 ¥39.9）。[CloudBase 官方定价页](https://cloudbase.cloud.tencent.com/pricing)确认个人版限时优惠为 ¥19.9/月、每月 40,000 资源点；付费套餐用量超限后可按量继续使用，具体超额计费须在购买页核实。未点击最终创建/支付按钮。CloudBase 官方说明既有传统环境不能升级为 PG，需新建 PG 模式环境；桌面控制台这张表单目前没有在已观察区域显示数据库模式选项。创建 PG 环境前仍须核实购买页的模式和费用，并取得用户对至少 ¥19.9/月及可能超额费用的明确授权。

## 费用核实表

2026-10-06 [官方定价页](https://cloudbase.cloud.tencent.com/pricing)读取失败，未得到可引用的完整价格表。以下列出计算依据，金额全部待控制台核实；不能把优惠套餐价当总价。

| 项目 | 低使用量依据 | 增长后依据 | 待核实项 |
|---|---|---|---|
| 云托管计算 | 实际活跃实例秒 × CPU/内存规格 | 实例秒与扩容上限 | 单价、包内量、最低规格 |
| PostgreSQL | 最小合适规格、存储、实际暂停策略 | CPU/内存/IO、连接数、存储 | 可用地域、规格与计费 |
| 网关 | HTTPS 调用量与配额 | 峰值请求与限流 | 配额、超额与入口费 |
| 流量 | 实测上传/拉取字节 | 增量设备数与全量快照 | 公网/同地域流量 |
| 日志 | 脱敏访问/错误日志量 | 吞吐和保留期 | 存储及查询计费 |
| 备份 | 数据库全量/增量大小 | 增长量及恢复点目标 | 保留期与恢复权限 |
| 域名 | 测试平台域名 | 正式自有域名 | 域名与证书费用 |
| 可选常驻 | 最小实例零的实际首请求测量 | 常驻实例秒 | 额外固定费用 |

没有负载实测和账号报价前不估算用户承载量，不承诺任何冷启动速度。[扩缩容官方说明](https://docs.cloudbase.net/run/deploy/configuring/autoscaling/about-instance-autoscaling)需结合控制台配置验收。

## 监控与发布顺序

记录请求 ID、状态码、延迟、连接池等待、错误码、冲突数、迁移错误；不记录凭证或完整事实。为 5xx、401 增长、连接耗尽、存储配额、备份失败建立告警，记录处理责任人。

先上线兼容后端和增量迁移，再灰度可升级客户端，最后启用真实同步。当前不称为可发布版本。回退保持数据库与新命名空间；不可删除新库、tombstone 或幂等回执。旧小程序只认识旧键，不能保证其看到新空间中的后续资料。恢复方法见 backup-recovery.md。
