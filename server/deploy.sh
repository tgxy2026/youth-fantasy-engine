#!/usr/bin/env bash
# 青春幻想引擎 · 网页体验版 一键部署（Ubuntu 22.04 / 腾讯云轻量应用服务器）
# 用法：sudo bash server/deploy.sh
# 前置：
#   1) 本机已用 `npm run build:web` 生成 dist-web/
#   2) 已把本仓库的 server/ 目录传到服务器（与 deploy.sh 同目录）
#   3) 部署前修改 server/yfe-feedback.service 里的 INVITE_CODE
set -e

APP_DIR=/var/www/yfe
SRV_DIR=/opt/yfe-server
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 安装 nginx =="
apt-get update
apt-get install -y nginx curl

echo "== 安装 Node.js 20 LTS（反馈服务用到 top-level await / randomUUID，系统 apt 的 nodejs 为 v12 过旧不可用）=="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version

echo "== 放置网页静态文件 =="
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$HERE/../dist-web/." "$APP_DIR/" 2>/dev/null || cp -r dist-web/. "$APP_DIR/"

echo "== 放置反馈服务 =="
mkdir -p "$SRV_DIR"
cp "$HERE/feedback-server.mjs" "$SRV_DIR/"
cp "$HERE/yfe_proxy_params" /etc/nginx/yfe_proxy_params
cp "$HERE/yfe-feedback.service" /etc/systemd/system/
# 反馈服务以 www-data 运行，需预建数据目录并赋权，否则启动 mkdir /var/lib/yfe 会因权限失败
mkdir -p /var/lib/yfe
chown -R www-data:www-data /var/lib/yfe
systemctl daemon-reload
systemctl enable --now yfe-feedback

echo "== 配置 nginx =="
cp "$HERE/yfe.conf" /etc/nginx/sites-available/yfe
ln -sf /etc/nginx/sites-available/yfe /etc/nginx/sites-enabled/yfe
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "== 完成 =="
echo "若已绑定域名，请把 server/yfe.conf 里的 'server_name _' 改为你的域名，然后："
echo "    sudo certbot --nginx -d 你的域名"
echo "未绑定域名也可先用 http://服务器IP 访问（邀请码在 /etc/systemd/system/yfe-feedback.service 的 INVITE_CODE）。"
