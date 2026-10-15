# 2026-10-12 云端自动保存更新

用户明确授权配置本机终端连接并部署云端后端。

- 本机创建专用 Ed25519 密钥 `~/.ssh/yotick`，私钥权限限当前 Windows 用户。通过已有 Workbench 会话把公钥追加到服务器 authorized_keys，没有替换旧公钥或启用密码认证。
- 本机 SSH 别名 `yotick-cloud`，复用已验证的 known_hosts，StrictHostKeyChecking=yes；`ssh yotick-cloud` 实际连接成功。
- 部署包：server/delivery/YoTick-backend-20261012-133131.zip，87 个 manifest 文件，SHA256 `6352e7407c12349252a96209217a2ea544973e10838595b5876dce6f1363e137`。上传后 manifest 验证通过。
- 部署前加密备份：`/var/lib/yotick-backups/yotick-20261012T060210Z.dump.enc`，服务 Result=success、ExecMainStatus=0；SHA256 `1e37d6c71deda674cd4b190cafd834fc90ed825b6d7dde0fdb38505b13a535d3`。
- 旧版本 `/opt/yotick/releases/ecs-ready-20261008` 保留。新版 `/opt/yotick/releases/guest-auto-20261012-1402`。本次没有数据库迁移或数据恢复，迁移文件集合保持 001 至 005。
- 用新版本自带的 activate-release.sh 原子切换；旧版本没有该脚本。健康检查失败时脚本自动回滚旧代码。
- 服务启动时间为 2026-10-12 14:03:20 CST，ActiveState=active。current 链接和实际服务进程工作目录均为新版本，ready 返回 status=ok。
- 云端 imports.js 与 guest-merge.js 摘要和本地已测试构建完全一致。新接口明确返回 KEEP_ACCOUNT 能力标识。
- 云端运行已部署的自动合并模块，使用内存样例验证保留账号资料、跳过已删除记录；没有向真实账号导入样例。
- 手机所用 HTTPS 地址证书校验结果 0，未认证 /api/v1/me 返回预期 401。

手机下一步：再次点击“一起保存”，验证当前设备实际游客副本的自动整理结果。不能以代码与健康检查冒充真机导入已完成。
