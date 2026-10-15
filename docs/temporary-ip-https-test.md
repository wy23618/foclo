# 无域名时的临时云端手机测试

更新时间：2026-10-09。此方案只用于开发版真机验收，不满足正式发布要求。ECS公网IP为 `121.199.74.171`，API继续只绑定 `127.0.0.1:3000`，PostgreSQL继续只绑定 `127.0.0.1:5432`。Certbot IP短期证书有效至2026-10-15，必须保持自动续期。

## 当前已部署

- 仅开发版手机选择 `https://121.199.74.171/api/v1`；开发者工具模拟器仍用本机回环地址，trial/release继续为空。
- `sync/request.js` 只对精确匹配的开发入口启用微信调试模式；正式构建不会选中这条IP地址。
- 用户同意后，阿里云安全组新增 IPv4 TCP 80/443 全网入站规则。没有开放API 3000或数据库5432。
- ECS已安装Nginx与Certbot 5.8.0，证书来自Let's Encrypt短期IP证书；Nginx的80端口只提供ACME挑战，其它路径404；443只代理`/api/v1/`。
- 从外部读取HTTP挑战文件实测200。外部HTTPS访问`/api/v1/me`通过证书验证并返回预期401；服务器监听检查确认API和PG仅绑定回环。
- 2026-10-09再次从开发电脑访问`https://121.199.74.171/api/v1/me`，TLS验证结果为0，接口返回预期401 `AUTH_REQUIRED`。
- 同日从开发电脑定向探测公网TCP端口：80/443可达，3000/5432连接超时；这与仅公开Nginx、将API和PostgreSQL限制在本机的部署边界一致。
- `yotick-ip-cert-renew.timer`已由脚本启用，每6小时检查一次，service调用`/opt/yotick-certbot-venv/bin/certbot`。2026-10-09核对timer为enabled/active，执行`certbot renew --dry-run --cert-name 121.199.74.171`成功，输出所有模拟续期成功。
- 2026-10-09开发电脑直连TLS并开启证书链校验成功；当前Let’s Encrypt证书有效期为2026-10-08 14:37 UTC至2026-10-15 06:37 UTC。这里只证明当前证书有效，下一次无人值守续期仍需通过定时器观察。

## Certbot IP证书说明

Let’s Encrypt目前允许Certbot申请公网IP证书，IP证书使用约6天有效的`shortlived`配置。官方说明要求Certbot至少5.4；Webroot申请需要公网80可达，续期需要部署钩子让Nginx重新读取证书。依据：[Let’s Encrypt IP证书与Certbot说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)、[IP证书开始普遍签发](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。

## 下一步验证

1. 已由用户确认手机扫码进入开发预览、微信登录成功并可以同步。ECS Nginx访问日志在不显示来源IP或请求内容的聚合检查中，记录到 `/api/v1/sync/pull` 共12次HTTP 200（最后记录为2026-10-08 23:56:46 +0800）及 `/api/v1/auth/refresh` HTTP 200。这证明开发手机当前能使用临时IP HTTPS访问云端；不代表完整故障专项或正式发布通过。
2. 按`device-acceptance.md`中尚未验证的场景继续做离线/重开/补传、并发冲突和删除隔离；现有平板基础登录同步删除报告不重复计为专项通过。
3. 临时公网验收完成后再关闭安全组80/443规则，复核公网不可达，并停用临时Nginx站点和续期timer。当前保留这些入口以支持用户授权范围内的开发验收。

## 正式发布仍需

IP证书不能替代域名、ICP备案和微信小程序合法请求域名。当前免费试用按量ECS不满足大陆ICP备案条件；正式上线仍需符合条件的域名与云资源、备案、微信后台HTTPS域名登记，并使用正式域名配置重新部署和验收。不得把临时IP地址当作正式服务承诺。

## 最新开发预览

2026-10-08 微信开发者工具CLI生成当前源码预览成功，包783,546字节；这是开发预览二维码，不是体验版审核或公开发布。二维码保存在当前用户私有目录`%LOCALAPPDATA%\YoTick\CloudServer\YoTick-temp-https-preview.png`。手机扫描后可核对微信是否允许IP HTTPS调试登录与同步。若不能登录，请保留错误提示并反馈；不要清除本地数据。

2026-10-08手机已扫描临时HTTPS开发预览并能进入小程序。2026-10-09用户确认微信登录成功且可以同步；手机公网基础验收通过，故障专项仍待继续。
