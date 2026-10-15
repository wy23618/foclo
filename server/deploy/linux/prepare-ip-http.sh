#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
if ! command -v nginx >/dev/null 2>&1; then
  echo "Install Nginx from the Ubuntu package repository first." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install -d -o root -g root -m 0755 /var/www/yotick-acme/.well-known/acme-challenge
install -o root -g root -m 0644 "$script_dir/nginx/yotick-ip-http.conf" /etc/nginx/sites-available/yotick-ip.conf
ln -sfn /etc/nginx/sites-available/yotick-ip.conf /etc/nginx/sites-enabled/yotick-ip.conf
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx
echo "HTTP ACME challenge site is ready. Other paths return 404."
