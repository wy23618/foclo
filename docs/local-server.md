# Foclo 旧版本机 API/PostgreSQL 开发环境

> 历史开发与恢复资料：当前线上 API 和数据存储使用 Cloudflare Workers 与 SQLite Durable Objects，常规部署请看 [Cloudflare 指南](CLOUDFLARE.md)。本文件只描述本地 PostgreSQL 兼容环境，不是 VPS 方案或当前线上服务入口。旧路径和 `YOTICK_` 配置名保留以读取本机现有资料。

本地开发使用这台 Windows 电脑运行 Foclo API 与独立 PostgreSQL 17 数据目录，不依赖 CloudBase，也不触碰电脑上已有的 PostgreSQL 服务数据。数据库目录、随机口令和服务日志保存在 `%LOCALAPPDATA%\YoTick\LocalServer`；项目运行凭证保存在被 Git 忽略的 `server/.env`。如果 PostgreSQL 安装在其他目录，可将 `YOTICK_POSTGRES_BIN` 设为包含 `initdb.exe` 和 `pg_ctl.exe` 的 `bin` 目录。

首次启动会在本机创建独立数据库集群，监听 `127.0.0.1:5433`，并以 `yotick_app`（应用）和 `yotick_migrator`（迁移）两个受限账号运行迁移。默认 API 只监听 `127.0.0.1:3000`。数据目录会在停止后保留，不要手动删除。

在项目目录打开 PowerShell 后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\local-dev\start.ps1
```

启动脚本会编译后端、幂等执行数据库迁移、应用运行角色权限并启动 API。健康检查地址为 `http://127.0.0.1:3000/health/live` 和 `http://127.0.0.1:3000/health/ready`。

停止服务但保留数据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\local-dev\stop.ps1
```

核对重启前后的事实与同步回执（在 server 目录运行；只读访问独立本机数据库）：

```powershell
node --env-file=.env local-dev/verify-persistence.mjs baseline
# 用上面的 stop/start 脚本重启后，再运行：
node --env-file=.env local-dev/verify-persistence.mjs compare
```

核对过程只输出数量和最近记录的状态/时长，不输出项目名称、身份或凭证。baseline 保存六张事实/同步表的摘要；compare 不一致时拒绝声明数据保留通过。两次核对之间新增资料会导致摘要变化，应另行核实而非覆盖原基线。

当前电脑已有PostgreSQL17工具。脚本使用独立数据目录和5433端口，不停止或修改其他PostgreSQL服务。首次启动生成占位微信密钥；当前本机AppSecret已安全配置，开发者工具和手机均已有真实登录证据。开发者工具develop构建使用回环API；手机develop构建当前使用云端临时HTTPS入口，同热点HTTP调试作为备用。体验版/正式版不选用这些临时地址。手机不能使用127.0.0.1访问电脑；正式部署仍需域名、备案和微信合法域名。

## 手机热点下的临时真机调试

电脑和手机在同一开发网络时，也可用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\server\local-dev\start.ps1 -LanDebug` 暂时让API监听电脑当前Wi-Fi地址（数据库仍只接受本机连接）。这是此前的局域网调试备用方式；当前开发版手机已切换到云端临时HTTPS地址，DevTools模拟器仍使用回环。此前的10.22.4.17与192.168.199.9属于历史热点配置，不代表当前手机入口。若重新使用局域网调试，更新sync/environment.js、重新启动并生成新预览码后再测；启动脚本会拒绝配置不匹配的旧地址。

该方式使用 HTTP，仅用于手机和电脑同一热点下的开发调试；手机侧需要在小程序右上角菜单开启“调试”。Windows 防火墙若拦截连接，需允许 Node.js 在当前热点网络接收连接；启动脚本不会自动修改防火墙。停止/恢复仅本机访问时，运行上面的 `stop.ps1`，再用普通 `start.ps1` 启动。正式体验版/发布仍要 HTTPS 地址和微信后台合法域名。

LAN 调试启动时，脚本设置仅供 development 使用的 LOCAL_DEV_LOOPBACK=true，同时保留 127.0.0.1:3000 供电脑模拟器连接。手机热点地址与回环入口由同一 API 进程提供，共享数据库连接池；PostgreSQL 不对手机开放。普通本机模式设为 false；生产环境忽略此附加监听开关。

## 创建本机完整备份

在server目录运行`node --env-file=.env local-dev/backup.mjs`。工具只接受独立本机数据库，将完整pg_dump加密为AES-256-GCM的.dump.enc归档并记录摘要。密钥由当前Windows账户的DPAPI保护，口令和密钥不进入命令参数。只有加密归档成功写入后才删除本次生成的明文中间文件；失败.partial留在受限目录，不覆盖或自动删除旧备份。原有.dump仍可恢复，旧归档没有自动加密或清理。

验证归档时运行`node --env-file=.env local-dev/verify-dump-restore.mjs <备份文件名.dump或.dump.enc>`；加密归档在受限目录临时解密，只恢复到新建隔离库，finally删除本次解密临时文件。演练检查17表及旧游标失效。归档与DPAPI密钥文件不能放进小程序或公开部署包。DPAPI依赖原Windows用户；换机前在原账户完成解密转移，或在受保护环境中配置独立BACKUP_ENCRYPTION_KEY。不要把密钥发到聊天。备份位于同一电脑并不防整机丢失，正式异地备份另行配置。

本机start.ps1会启动独立当前用户backup-daemon进程，stop.ps1同步停止；重复启动通过PID及精确命令行核对避免重复进程。它每日检查成功备份，启动补做当天缺失备份；运行期间北京时间20:00以后每5分钟重试缺失备份。维护状态backup-maintenance.json及脱敏日志在LocalServer。每天已经成功时不重复生成。Windows计划任务在本环境被策略拒绝，失败任务已移除；当前方式不依赖该计划任务、AI定时执行或用户口令。
