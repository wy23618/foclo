#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
if [[ ! -x /opt/yotick-certbot-venv/bin/certbot ]]; then
  echo "Install Certbot 5.4 or newer at /opt/yotick-certbot-venv/bin/certbot first." >&2
  exit 1
fi
if [[ ! -s /etc/letsencrypt/live/121.199.74.171/fullchain.pem || ! -s /etc/letsencrypt/live/121.199.74.171/privkey.pem ]]; then
  echo "The publicly trusted IP certificate must be issued before enabling HTTPS." >&2
  exit 1
fi
if [[ ! -f /etc/nginx/sites-available/yotick-ip.conf ]]; then
  echo "Run prepare-ip-http.sh first." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install -o root -g root -m 0644 "$script_dir/nginx/yotick-ip-https.conf" /etc/nginx/sites-available/yotick-ip.conf
install -o root -g root -m 0755 "$script_dir/nginx/reload-yotick-ip-certificate" /usr/local/sbin/reload-yotick-ip-certificate
install -o root -g root -m 0644 "$script_dir/yotick-ip-cert-renew.service" /etc/systemd/system/yotick-ip-cert-renew.service
install -o root -g root -m 0644 "$script_dir/yotick-ip-cert-renew.timer" /etc/systemd/system/yotick-ip-cert-renew.timer
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable --now yotick-ip-cert-renew.timer
echo "HTTPS proxy and automatic certificate renewal timer are enabled."
