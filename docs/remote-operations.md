# 本机远程操作

已于 2026-10-24 实测本机 `ssh my-server` 无交互认证连接成功，Cloudflare Wrangler 已登录。日常操作从项目 PowerShell 执行，无需打开浏览器控制台。

```powershell
# 当前线上 API 健康检查
.\scripts\remote.ps1
# 当前 Cloudflare 后端部署记录
.\scripts\remote.ps1 -Target cloudflare
# 当前 Cloudflare 实时日志；Ctrl+C 结束
.\scripts\remote.ps1 -Target logs
# 历史 ECS 远程 shell
ssh my-server
# 从本机执行一条 ECS 命令
.\scripts\remote.ps1 -Target ecs -Command 'hostname; systemctl is-active postgresql'
```

线上 API 与账号数据在 Cloudflare Workers / Durable Object。ECS 仅保留历史 PostgreSQL 与备份，`yotick.service` 已停止；不要为了连接服务器重新启动历史 API。

SSH 复用当前 Windows 用户现有配置、专用密钥与已核对的主机指纹，凭据不保存在仓库。Cloudflare 复用本机 Wrangler 认证；若认证以后失效，按平台要求重新认证。例行操作不自动运行登录浏览器。
