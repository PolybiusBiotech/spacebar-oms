#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/spacebar-oms}"
APP_USER="${APP_USER:-pi}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo on the Raspberry Pi." >&2
  exit 1
fi

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .env \
  ./ "$APP_DIR"/

if [[ ! -f /etc/spacebar-oms.env ]]; then
  install -m 600 -o root -g root "$APP_DIR/.env.example" /etc/spacebar-oms.env
  echo "Created /etc/spacebar-oms.env. Edit it before starting the OMS."
fi

install -m 644 "$APP_DIR/ops/spacebar-oms.service" /etc/systemd/system/spacebar-oms.service
install -m 644 "$APP_DIR/ops/spacebar-oms-browser.service" /etc/systemd/system/spacebar-oms-browser.service

systemctl daemon-reload
systemctl enable spacebar-oms.service spacebar-oms-browser.service

echo "Installed. Configure /etc/spacebar-oms.env, then run:"
echo "  sudo systemctl restart spacebar-oms.service spacebar-oms-browser.service"
