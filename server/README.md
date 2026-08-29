# 青春幻想引擎 · 网页体验版 部署包

邀请制静态网页体验版：**项目数据 + AI 密钥 100% 存用户浏览器（IndexedDB / localStorage），服务器零持久化；仅当用户主动提交反馈时才向我们发送数据。**

## 架构
- 前端：纯静态站（`npm run build:web` → `dist-web/`），数据走浏览器 IndexedDB。
- 反向代理：nginx 同时承担
  - 静态托管 SPA；
  - `/api/ai/<host>/` 同源反代到各 AI 平台（解决浏览器 CORS，仅转发、不记日志）；
  - `/api/feedback`、`/api/invite/check` 转发到本地反馈服务。
- 反馈服务：`feedback-server.mjs`（Node 内置模块，零依赖），落盘到 `/var/lib/yfe`，不建用户库。

## 你（老大）需要做的
1. **租服务器**：腾讯云「轻量应用服务器」Ubuntu 22.04，1C2G 足够；安全组放行 22 / 80 / 443。
2. **（可选）域名**：注册域名并把 A 记录指向服务器 IP，用于 HTTPS 与好记网址；不绑也能先用 `http://IP`。
3. **本地构建**：`npm run build:web`（生成 `dist-web/`）。
4. **传文件到服务器**：把 `dist-web/` 与 `server/` 目录传上去。
5. **改邀请码**：编辑 `server/yfe-feedback.service` 里的 `INVITE_CODE=CHANGE_ME` → 你的码。
6. **一键部署**：`sudo bash server/deploy.sh`。
7. **（有域名时）HTTPS**：把 `server/yfe.conf` 的 `server_name _` 改成域名，再 `sudo certbot --nginx -d 域名`。

## 隐私红线（务必保持）
- 反馈服务不读取、不存储任何项目创作内容；只存用户主动提交的文本（及可选附带文件）。
- AI 反代 `access_log off`，不落请求体；用户 key 仅经服务器转发，不写入磁盘。
- 邀请码只在服务端比较，不进客户端包。

## 已知限制
- 本版数据 per-browser，**不跨设备同步**（跨设备同步见清单 #001 方案 A）。
- 自定义 AI 端点（非白名单 host）在网页版会撞 CORS：要么在对应平台后台把体验版域名加入允许来源，要么在 `yfe.conf` 自行加一条反代。
- 网页版 JS 仅压缩未混淆；2.0 的 `javascript-obfuscator` 对网页版同样建议启用。
