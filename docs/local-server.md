# YoTick 本机服务器

本地开发使用这台 Windows 电脑运行 YoTick API 与独立 PostgreSQL 17 数据目录，不依赖 CloudBase，也不触碰电脑上已有的 PostgreSQL 服务数据。数据库目录、随机口令和服务日志保存在 `%LOCALAPPDATA%\YoTick\LocalServer`；项目运行凭证保存在被 Git 忽略的 `server/.env`。如果 PostgreSQL 安装在其他目录，可将 `YOTICK_POSTGRES_BIN` 设为包含 `initdb.exe` 和 `pg_ctl.exe` 的 `bin` 目录。

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

当前电脑已有 PostgreSQL 17 工具。脚本使用单独的数据目录和 5433 端口，不停止或修改现有 PostgreSQL 服务。首次启动会生成不可用于真实登录的占位微信密钥；真实 `wx.login` 需将 AppSecret 安全配置到 `server/.env`。目前本机已完成该配置，开发者工具模拟器已实际登录并首次同步。`sync/config.js` 只在开发者工具模拟器的 develop 版本选用本机 API；体验版/正式版与手机不会使用本机地址。项目私有设置中的 `urlCheck` 已关闭，仅用于本地模拟器访问 HTTP 回环地址；正式部署仍需 HTTPS 和合法域名。手机、其他电脑和公网访问需要单独配置 HTTPS/域名/网络，不能直接使用 `127.0.0.1`。

## 手机热点下的临时真机调试

电脑和手机连接同一个手机热点后，可用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\server\local-dev\start.ps1 -LanDebug` 暂时让 API 监听电脑当前热点地址（数据库仍只接受本机连接）。当前热点调试地址为 `192.168.199.9`，只在小程序 develop 开发版的 iOS/Android 上使用；模拟器继续使用回环地址，体验版/正式版不选用该地址。热点重连后电脑地址可能变化；更新 `sync/environment.js` 中的 `LAN_DEBUG_API_HOST`、重新启动服务并重新生成预览码后再测试。启动脚本会拒绝监听配置不匹配的旧地址。

该方式使用 HTTP，仅用于手机和电脑同一热点下的开发调试；手机侧需要在小程序右上角菜单开启“调试”。Windows 防火墙若拦截连接，需允许 Node.js 在当前热点网络接收连接；启动脚本不会自动修改防火墙。停止/恢复仅本机访问时，运行上面的 `stop.ps1`，再用普通 `start.ps1` 启动。正式体验版/发布仍要 HTTPS 地址和微信后台合法域名。
