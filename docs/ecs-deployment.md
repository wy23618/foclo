# 历史阿里云服务器部署记录

> 当前线上 API 已迁移到 Cloudflare。此文只作为旧环境与备份的历史记录；旧 PostgreSQL 保留在服务器上，旧 `yotick.service` 已停止。不要按本文启动旧 API 或将客户端重新指向旧数据库。当前状态见 [Cloudflare 指南](CLOUDFLARE.md)。

更新：2026-10-09。服务器内部部署、隔离备份恢复、临时IP HTTPS手机开发预览登录/同步和证书续期dry-run已通过；正式发布仍受域名、备案和运营资料限制。

补充：真实开发者工具wx.login凭据已经在云端向微信成功验证，login200、me200且与迁移账号一致，测试会话logout204。验证工具第一轮误把预期退出码写为200而报错，核对实际服务204后已修正并用新真实凭据完整复验通过。该项是云端真实身份交换，不是手机公网HTTPS链路验收。

## 已运行

- ECS：杭州，121.199.74.171，Ubuntu 22.04，2核/2GiB、40GiB。用户自行领取试用，没有代理购买、变配或付费开通。
- Node 24.21.0、PostgreSQL 17.11，使用官方来源并核对 Node 下载摘要。Ubuntu 软件更新已执行。
- 后端目录 `/opt/yotick/current`，systemd 服务 `yotick.service`，专用非登录用户 yotick。Node 堆384MiB，服务硬限制768MiB。
- API 仅监听 `127.0.0.1:3000`；数据库仅监听 `127.0.0.1:5432`。未将数据库开放公网。
- 业务连接使用 SCRAM 和经专用 CA 验证的 TLS，证书包含127.0.0.1身份；明文数据库连接和错误 CA 均实际被拒绝。
- 应用角色非管理员，没有建表权限，不持有迁移管理员口令。数据库由不可登录的迁移角色持有。
- 微信 AppSecret 经已核对主机指纹的 SSH 传输，保存在 `root:yotick 0640` 的 `/etc/yotick/server.env`，没有写入小程序或聊天。

## 实际验收

从电脑专用测试库生成完整快照，保留电脑原库；恢复云端后对17张表的字段、行数、排序内容摘要逐项比较，一致。包含身份、空间、操作回执、删除标记、迁移和快照资料，没有丢弃未上传资料来通过验收。

云端 live/ready 均200，未认证 `/api/v1/me` 为401。受限应用身份和数据库 TLS 实际核验通过。整台 ECS 已重启，boot_id发生变化，PG与API自动启动，ready200、未登录401；备份和健康定时器均开机启用。重启后总内存1736MiB、可用约1290MiB，磁盘仍有约34GiB；这是空闲观测，不能推算用户容量。

## 备份和监测

每日北京时间02:30之后随机延迟最多15分钟执行 `yotick-backup.timer`，Persistent启用。备份为AES-256-GCM，根用户专用密钥 `/etc/yotick/backup.key`，归档 `/var/lib/yotick-backups` 0700。失败保留.partial，不标成功，不自动删除旧备份。

首份归档 `yotick-20261008T111818Z.dump.enc`，56520字节，SHA256 `63d5ccf8ed868391a318c6ba73695f6a3149c731354230dc4b9d74e44468ac29`。实际解密并恢复到新建隔离库 `yotick_restore_drill_33e5655e2d41`，17表一致；只改变隔离库restore_epoch，1个旧游标正确拒绝，运行库未改写。

2026-10-09 02:04 CST，Workbench手动启动同一yotick-backup.service后systemd结果success、退出0。最新加密归档为yotick-20261008T180442Z.dump.enc，57,405字节，AES-256-GCM，文件SHA256 d9e05b5e7df2964435fd9db948f1ff45dbcc6f420aa24eee1dfdce3632699710与旁置元数据匹配，pg_dump退出0；权限为root专用0600。02:07已通过独立隔离恢复流程解密并恢复这份归档：17表数据摘要一致、旧游标被拒绝、源运行库未修改，详见验收记录。归档旁置JSON的restoreVerified=false是生成时状态，本次演练另留了时间戳证据。备份目录所在文件系统总容量40GiB、可用34GiB（11%已用）。

较早归档`yotick-20261008T113901Z.dump.enc`已复制到电脑受限目录`C:/Users/Wenyang/AppData/Local/YoTick/CloudServer`，摘要一致；02:04生成并完成恢复演练的最新归档目前仍只在ECS上。云端备份密钥及服务环境的电脑副本用当前Windows用户DPAPI保护，保护/解保护回读验证通过；不要将.dpapi视为跨用户或重装Windows后可直接恢复的通用文件。尚未配置持续自动异地复制，也尚未承诺RPO/RTO。

每5分钟 `yotick-health.timer` 检查ready，失败产生systemd失败记录；日志容量上限100MiB、保留最多14天。没有外部通知渠道，不能把本机失败日志称为已通知运营者。

## 切换前仍需完成

1. 实际域名、解析和所需备案条件；有效公网HTTPS证书及微信合法请求域名。试用实例是否能作为新增备案资源需按账户资格处理，不能仅凭有公网IP判定可正式发布。
2. 公网微信登录、手机/平板在新地址的同步、故障专项及性能验收。电脑上的旧真机结果不替代云端结果。
3. 正式切换前暂停旧服务器写入、取得最终一致快照、核对操作回执，按恢复规则更新restore_epoch后再让客户端全量恢复。当前手机开发预览已连接云端临时IP，DevTools模拟器仍连接电脑；云端保留测试副本和手机同步产生的账号状态，不能把两边独立写入后直接当成已合并。当前没有迁移真实业务资料。
4. 正式运营主体/联系方式、隐私配置、持续异地备份/删除记录及告警接收方式。独立删除记录与恢复门禁已实现并以生成样本验证，见[注销恢复保护](deletion-ledger.md)；还需取得外部最新完整记录，未进行真实账号删除。

部署管理只使用临时SSH公钥；私钥在电脑受限目录，公钥禁止转发与PTY且设短期失效时间。部署操作结束撤销该公钥，保留阿里云Workbench管理方式；不要关闭主机指纹校验。

本轮收尾已实际撤销该临时公钥，重新SSH登录正确被拒；电脑临时私钥以及两端短期登录凭据/秘密传输中间文件已移除。最终版本ecs-ready-20261008，78项manifest核验通过。后续管理通过既有授权的Workbench接续。

## 2026-10-08 22:31 当前状态复核

阿里云控制台只读检查：实例健康正常，付费类型按量；没有执行转包月或其他收费变更。Workbench重新连接成功。服务器`ss -lntH`实测Node API只监听`127.0.0.1:3000`、PostgreSQL只监听`127.0.0.1:5432`，SSH监听IPv4/IPv6 22端口，没有80/443/3389监听。`yotick`与`postgresql`均为active，`yotick-backup.timer`与`yotick-health.timer`均enabled。

控制台安全组原来开放SSH 22、RDP 3389与ICMP给`0.0.0.0/0`。服务器为Ubuntu且无3389服务，已在控制台删除RDP公网规则并复核入站表已无3389；没有开放新的公网端口。当前公网SSH仍由全网可达，服务器有效配置`passwordauthentication no`、`pubkeyauthentication yes`、`permitrootlogin yes`、`maxauthtries 6`；Workbench免密连接用于管理。ICMP规则仍开放，未修改。截图证据保存在本机临时目录`C:/Users/Wenyang/AppData/Local/Temp/YoTick-ecs-security-group-20261008.png`。

## 工具入口

`server/deploy/linux/` 包含安装、分版本解压校验、首次配置、systemd、TLS/权限验证、每日备份和隔离恢复工具。首次配置脚本拒绝已有业务库，不能用于覆盖或重跑已经建库的部署。恢复演练仅创建唯一隔离库，不切换运行库。后续更新用新版本目录，核验后再切换current，保留旧版本和数据库。

## 2026-10-08 临时开发 HTTPS

用户确认后，安全组新增公网 IPv4 TCP 80/443；没有开放 3000/5432。服务器现运行Nginx和Certbot 5.8.0，IP短期证书有效至2026-10-15，Nginx反代HTTPS到本机API。外部ACME挑战返回200，外部未认证`/api/v1/me`通过证书链验证并返回401。API/PG依旧只绑定回环。每6小时证书续期timer已启用；2026-10-09 timer状态enabled/active，renew dry-run成功。用户确认微信开发版手机扫码进入、微信登录成功且可以同步；Nginx日志聚合到12次sync/pull 200。该临时IP入口只用于开发验收，正式版仍需域名、备案与微信合法域名。详见`temporary-ip-https-test.md`。

## 2026-10-09 续期、手机与备份复核

Workbench实测Certbot模拟续期成功、证书续期timer enabled/active。Nginx访问日志脱敏聚合记录12次`GET /api/v1/sync/pull` 200及1次`POST /api/v1/auth/refresh` 200。PostgreSQL聚合计数为1账号、1空间、17项目、12专注记录、44同步操作、37同步变更；未读取事实内容。用户表示无真实业务资料，既有测试数据继续保留。`yotick-backup.timer` enabled/active，最近一次备份service结果success、状态码0；持续异地复制和外部告警仍未配置。
