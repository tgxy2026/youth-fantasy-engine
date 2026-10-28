// ============ 服务端渲染的登录 / 注册页 ============
//
// 【为什么由服务端出页面，而不是让前端渲染】前端是纯静态 SPA，未登录时它一启动就去请求
// /api/data，拿到 401 只会挂写盘锁、弹出技术性红条 —— 作者看到的是「数据读取失败」，
// 而不是「请先登录」。服务端这一层直接把人挡在门口，前端代码可以一个字节都不改。
//
// 🔴 所有回显内容（用户名、错误提示）一律转义：登录页同样会被 XSS 打。
import { GITEE_RELEASES_URL } from './config.mjs'
import { authClient } from './authClient.mjs'
import { AUTH_STYLE } from './authStyle.mjs'

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

// 复用 app 图标（与 index.html 的 favicon 同款金色文档图形），登录页/重置页作为品牌 logo
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#44764e" width="40" height="40" aria-hidden="true"><path d="M4 4h12l4 4v12H4V4zm2 2v12h12V8.5L15.5 6H6zm2 3h8v2H8V9zm0 4h8v2H8v-2z"/></svg>`

const icon = (paths) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`
const EYE = icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')
const ARROW = icon('<path d="M5 12h14m-5-5 5 5-5 5"/>')
const CLOUD = icon('<path d="M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 17.7 8 5 5 0 0 1 18 18H7Z"/><path d="m9 13 2 2 4-4"/>')
const DOWNLOAD = icon('<path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/>')

// Decorative original SVG: no downloads, raster payload, font or animation loop.
const NIGHT_ART = `<svg class="night-art" viewBox="0 0 460 290" fill="none" aria-hidden="true">
  <defs><linearGradient id="night-orbit" x1="70" y1="40" x2="390" y2="260" gradientUnits="userSpaceOnUse"><stop stop-color="#638c5b" stop-opacity=".45"/><stop offset="1" stop-color="#638c5b" stop-opacity=".03"/></linearGradient><radialGradient id="night-glow"><stop stop-color="#8ca87b" stop-opacity=".15"/><stop offset="1" stop-color="#8ca87b" stop-opacity="0"/></radialGradient><linearGradient id="night-page" x1="230" y1="155" x2="230" y2="270" gradientUnits="userSpaceOnUse"><stop stop-color="#638c5b" stop-opacity=".1"/><stop offset="1" stop-color="#638c5b" stop-opacity="0"/></linearGradient></defs>
  <ellipse cx="230" cy="155" rx="200" ry="125" fill="url(#night-glow)"/>
  <circle cx="230" cy="144" r="107" stroke="url(#night-orbit)"/><circle cx="230" cy="144" r="84" stroke="#638c5b" stroke-opacity=".1" stroke-dasharray="2 7"/>
  <ellipse cx="230" cy="150" rx="190" ry="59" transform="rotate(-23 230 150)" stroke="url(#night-orbit)"/>
  <path d="M253 55a22 22 0 1 0 25 29 24 24 0 0 1-25-29Z" fill="#638c5b" fill-opacity=".85"/>
  <path d="m111 108 2-6 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm226 79 2-6 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" fill="#638c5b" fill-opacity=".8"/>
  <circle cx="335" cy="65" r="2" fill="#638c5b"/><circle cx="151" cy="212" r="2" fill="#638c5b"/><circle cx="88" cy="175" r="1.5" fill="#638c5b"/>
  <path d="M81 249 141 198l38 24 52-67 63 72 25-18 60 40" stroke="#638c5b" stroke-opacity=".15"/>
  <path d="M230 211c-31-23-61-31-94-25v57c37-5 63 1 94 21 31-20 57-26 94-21v-57c-33-6-63 2-94 25Z" fill="url(#night-page)" stroke="#567049" stroke-opacity=".55"/>
  <path d="M230 211v53m-94-14c37-5 63 1 94 21 31-20 57-26 94-21M149 201c23-1 44 6 64 17m-64-6c23-1 44 6 64 17m34-11c20-11 41-18 64-17m-64 28c20-11 41-18 64-17" stroke="#567049" stroke-opacity=".25"/>
  <path d="M44 277h372" stroke="#638c5b" stroke-opacity=".08"/>
</svg>`

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;min-height:100dvh;line-height:1.65;
  background:#f7f4ee;color:#2c2c2a;
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}

/* ===== 分栏布局：左品牌叙事区 / 右表单区 ===== */
.split{display:flex;width:100%;min-height:100vh;min-height:100dvh}
.panel{position:relative;flex:1 1 50%;display:flex;flex-direction:column;justify-content:center;gap:16px;
  padding:56px 52px;color:#f3ede0;overflow:hidden;
  background:radial-gradient(900px 520px at 18% 16%,rgba(126,116,206,.32),transparent 60%),
            radial-gradient(820px 480px at 86% 92%,rgba(217,160,74,.22),transparent 60%),
            linear-gradient(155deg,#20243f 0%,#2a2350 58%,#1b1f37 100%)}
.panel::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.75;
  background-image:radial-gradient(1.6px 1.6px at 18% 28%,rgba(255,245,220,.9),transparent),
    radial-gradient(1.4px 1.4px at 72% 62%,rgba(255,245,220,.8),transparent),
    radial-gradient(1.2px 1.2px at 42% 82%,rgba(255,245,220,.7),transparent),
    radial-gradient(1.4px 1.4px at 88% 22%,rgba(255,245,220,.8),transparent),
    radial-gradient(1.2px 1.2px at 30% 12%,rgba(255,245,220,.6),transparent),
    radial-gradient(1.6px 1.6px at 60% 46%,rgba(255,245,220,.7),transparent);
  background-repeat:no-repeat}
.panel>*{position:relative;z-index:1}
.panel .brand{text-align:left;margin-bottom:0}
.panel .logo{background:rgba(255,255,255,.08);border-color:rgba(217,160,74,.55);margin:0 0 4px;
  width:66px;height:66px;box-shadow:0 8px 24px -10px rgba(0,0,0,.5)}
.panel h1{font-size:30px;letter-spacing:.08em;color:#f7f1e4;margin-top:6px}
.panel .swap{margin-top:10px;text-align:left}
.panel .swap span{color:#cdbfa6;font-size:15px;letter-spacing:.05em}
.panel .features{margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:11px}
.panel .features li{list-style:none;display:flex;gap:11px;align-items:center;font-size:14px;color:#e7dec9;letter-spacing:.02em}
.panel .features li::before{content:'';width:7px;height:7px;border-radius:50%;background:#d9a04a;
  box-shadow:0 0 9px rgba(217,160,74,.85);flex:none}
.stage{flex:1 1 50%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:40px 28px;background:linear-gradient(160deg,#fbf8f2 0%,#f1ebdf 100%)}
.stage .card{width:100%;max-width:420px}
.stage .foot,.stage .dl{width:100%;max-width:420px}

/* ===== 卡片内（保留原样式） ===== */
.card{background:#fff;border:1px solid #e8e1d5;border-radius:14px;padding:26px 24px 22px;
  box-shadow:0 1px 2px rgba(60,48,30,.04),0 8px 24px -12px rgba(60,48,30,.12);
  animation:yfeRise .55s cubic-bezier(.2,.7,.3,1) both}
.brand{text-align:center;margin-bottom:26px}
.brand h1{font-size:21px;font-weight:600;letter-spacing:.06em;color:#1f1d1a}
.brand p{margin-top:7px;font-size:13px;color:#625b51;letter-spacing:.04em}
.tabs{display:flex;gap:6px;margin-bottom:20px;background:#f3efe7;padding:4px;border-radius:9px}
.tabs button{flex:1;min-height:44px;padding:8px 0;border:0;border-radius:6px;background:transparent;cursor:pointer;
  font-size:14px;color:#625b51;font-family:inherit;transition:background .15s,color .15s}
.tabs button.on{background:#fff;color:#1f1d1a;font-weight:500;box-shadow:0 1px 3px rgba(60,48,30,.1)}
label{display:block;font-size:14px;color:#514a40;margin:14px 0 6px;letter-spacing:.03em}
input{width:100%;min-height:44px;padding:10px 12px;font-size:16px;font-family:inherit;color:#2c2c2a;
  background:#fdfcfa;border:1px solid #e0d8ca;border-radius:8px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#c9a227;box-shadow:0 0 0 3px rgba(201,162,39,.12)}
button.submit{width:100%;min-height:44px;margin-top:22px;padding:11px 8px;font-size:15px;font-family:inherit;font-weight:500;
  color:#fff;background:#8a6d1f;border:0;border-radius:8px;cursor:pointer;letter-spacing:.06em;transition:background .15s}
button.submit:hover{background:#755c19}
button.submit:disabled{background:#b9ab8b;cursor:not-allowed}
.msg{margin-top:14px;padding:9px 12px;font-size:14px;line-height:1.6;border-radius:8px;display:none}
.msg.err{display:block;background:#fdf0ee;border:1px solid #f3cfc8;color:#a4342a}
.msg.ok{display:block;background:#f0f7ef;border:1px solid #cfe5cb;color:#3d6b36}
.foot{margin-top:18px;text-align:center;font-size:13px;line-height:1.9;color:#625b51}
.foot b{color:#7c7468;font-weight:500}
.dl{margin-top:14px;padding-top:12px;border-top:1px solid #eee8dc;font-size:13px;line-height:1.9;color:#625b51;text-align:center}
.dl a{color:#8a6d1f;text-decoration:none;border-bottom:1px solid rgba(138,109,31,.35);transition:color .15s,border-color .15s}
.dl a:hover{color:#6b5316;border-bottom-color:#6b5316}
.forgot{margin-top:12px;text-align:center;font-size:13px}
.forgot a{color:#8a6d1f;text-decoration:none;border-bottom:1px solid rgba(138,109,31,.35)}
.forgot a:hover{color:#6b5316}
.resetNote{margin-top:14px;padding:10px 12px;font-size:13px;line-height:1.75;color:#625b51;
  background:#faf7f1;border:1px solid #eee8dc;border-radius:8px}
.orDivider{display:flex;align-items:center;gap:10px;margin:18px 0 12px;font-size:13px;color:#625b51}
.orDivider::before,.orDivider::after{content:'';flex:1;height:1px;background:#e8e1d5}
.guestBtn{display:block;min-height:44px;text-align:center;padding:10px 8px;font-size:14px;color:#514a40;text-decoration:none;
  border:1px solid #e0d8ca;border-radius:8px;transition:border-color .15s,color .15s,background .15s}
.guestBtn:hover{border-color:#c9a227;color:#8a6d1f;background:#fdfbf5}
.guestNote{margin-top:10px;font-size:13px;line-height:1.75;color:#625b51;text-align:center}
.guestNote b{color:#8a6d1f;font-weight:500}
.cancel{width:100%;min-height:44px;margin-top:8px;background:transparent;border:1px solid #b7ab95;border-radius:8px;color:#514a40;font:inherit;cursor:pointer}
[hidden]{display:none!important}
button:disabled{cursor:wait;opacity:.7}
input:disabled{opacity:.8}
:is(button,a,input,.msg):focus-visible{outline:3px solid #755c19;outline-offset:3px}
.msg:focus{outline:2px solid #755c19;outline-offset:2px}
a{overflow-wrap:anywhere}
.logo{display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;margin:0 auto 14px;
  background:#fdfbf5;border:1px solid #e6dcc6;border-radius:18px;box-shadow:0 6px 18px -10px rgba(60,48,30,.25)}
.logo svg{display:block}
.brand .swap{position:relative;min-height:20px;margin-top:7px}
.brand .swap span{position:absolute;left:0;right:0;top:0;opacity:0;transition:opacity .6s ease;
  font-size:13px;color:#625b51;letter-spacing:.04em}
.brand .swap span.on{opacity:1}
@keyframes yfeRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media(max-width:360px){.card{padding:20px 16px}.brand{margin-bottom:18px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media(forced-colors:active){.card,input,.tabs,button.submit,.cancel,.guestBtn,.msg{border:1px solid CanvasText}button.submit{background:ButtonFace;color:ButtonText}:focus-visible{outline-color:Highlight}}
@media(max-width:860px){
  .split{flex-direction:column;min-height:auto}
  .panel{padding:40px 24px 30px;justify-content:flex-start;gap:12px}
  .panel .features{display:none}
  .panel h1{font-size:25px}
  .stage{padding:30px 16px 44px}
}
`

/**
 * @param {{mode:'invite'|'open'|'closed', notice?:string, error?:string}} opts
 */
export function renderAuthPage({ mode = 'invite', notice = '', error = '' } = {}) {
  const canRegister = mode !== 'closed'
  const needInvite = mode === 'invite'
  const msgClass = error ? 'err' : notice ? 'ok' : ''
  const msgText = escapeHtml(error || notice)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>登录 · 青春幻想引擎</title>
<meta name="theme-color" content="#e6f0e0">
<style>${AUTH_STYLE}</style>
</head>
<body class="auth-entry">
<main class="split">
  <section class="panel" aria-labelledby="brand-title">
    <div class="brand">
      <div class="logo">${LOGO_SVG}</div>
      <div><p class="brand-name">青春幻想引擎</p><p class="brand-en" lang="en">YOUTH FANTASY ENGINE</p></div>
    </div>
    <div class="story">
      <p class="eyebrow" lang="en">A SPACE FOR YOUR IMAGINATION</p>
      <h1 id="brand-title">让想象，<br><span>自成宇宙。</span></h1>
      <p class="story-lead">把脑海里的世界，写成可以居住的故事。</p>
      <p class="story-note">角色、设定、章节与灵感，<br>在这里，汇聚成属于你的幻想世界。</p>
      ${NIGHT_ART}
    </div>
    <div class="brand-foot"><span>作品与设定各自独立 · 灵感有迹可循</span><span aria-hidden="true">✦</span></div>
  </section>
  <section class="stage" aria-labelledby="form-title">
    <div class="card">
      <header><p class="card-kicker" lang="en">YOUR NEXT CHAPTER</p><h2 id="form-title">欢迎回来</h2><p class="card-subtitle" id="form-subtitle">继续你的幻想世界之旅。</p></header>
      ${canRegister ? `<div class="tabs" id="tabs" role="group" aria-label="账号操作">
        <button type="button" data-tab="login" class="on" aria-pressed="true">登录</button>
        <button type="button" data-tab="register" aria-pressed="false">注册</button>
      </div>` : ''}

      <form id="form" autocomplete="on" aria-labelledby="form-title">
        <label for="name">用户名</label>
        <input id="name" name="name" required maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="name-error" placeholder="输入你的用户名">
        <p class="field-error" id="name-error" hidden></p>

        <label for="pwd">密码</label>
        <div class="password-wrap">
        <input id="pwd" name="password" type="password" required minlength="6" maxlength="128"
               autocomplete="current-password" aria-describedby="pwd-error" placeholder="输入密码，至少 6 位">
        <button class="password-toggle" id="password-toggle" type="button" aria-label="显示密码" aria-controls="pwd" aria-pressed="false">${EYE}</button>
        </div>
        <p class="field-error" id="pwd-error" hidden></p>

        <div id="inviteBox" style="display:none">
          <label for="invite">邀请码</label>
          <input id="invite" name="invite" maxlength="32" autocapitalize="none" spellcheck="false" aria-describedby="invite-note invite-error" placeholder="输入站主发放的邀请码">
          <p class="field-note" id="invite-note">邀请码也是找回密码的凭证，请妥善保管。</p>
          <p class="field-error" id="invite-error" hidden></p>
        </div>

        <div class="forgot"><a href="/reset">忘记密码？</a></div>
        <button class="submit" id="btn" type="submit">进入创作空间</button>
        <button class="cancel" id="cancel" type="button" hidden>停止等待</button>
      </form>

      <div class="msg ${msgClass}" id="msg" tabindex="-1" role="${error ? 'alert' : 'status'}">${msgText}</div>

      <div class="orDivider"><span>也可以先看看</span></div>
      <a class="guestBtn" href="/guest">先以游客身份探索 ${ARROW}</a>
      <p class="guestNote">
        游客数据仅保存在<b>当前浏览器</b>，不会上传<br>
        清理浏览器或换设备后<b>无法找回</b>，请及时导出备份
      </p>
    </div>
    <div class="foot">
      <p class="cloud-note">${CLOUD} 账号数据云端保存，按账号隔离</p>
      <p>每账号默认 200 MB 空间 · 可随时导出全部数据</p>
      <div class="dl"><a href="${GITEE_RELEASES_URL}" target="_blank" rel="noreferrer noopener">${DOWNLOAD} 下载桌面版 / 便携版</a></div>
      <p>离线创作 · 支持导出 PDF</p>
    </div>
  </section>
</main>

<script>(${authClient.toString()})({canRegister:${canRegister},needInvite:${needInvite}});</script>
</body>
</html>`
}

/**
 * 重置密码页（WEB-06：凭注册时那张邀请码）。
 *
 * 【为什么这么设计】站主亲手发码、码与账号一对一绑定 ⇒ 邀请码本身就是最合适的找回凭证，
 * 不需要邮件服务。用户名与邀请码必须**同时匹配**才放行（服务端同口径校验）。
 *
 * @param {{error?:string, name?:string}} opts error=失败原因；name=重置成功的用户名（走成功态）
 */
export function renderResetPage({ error = '', name = '' } = {}) {
  const done = !!name
  const msgClass = error ? 'err' : ''
  const msgText = escapeHtml(error)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>重置密码 · 青春幻想引擎</title>
<style>${STYLE}</style>
</head>
<body>
<div class="split">
  <section class="panel">
    <div class="brand">
      <div class="logo">${LOGO_SVG}</div>
      <h1>重置密码</h1>
      <p class="swap" aria-hidden="true"><span class="on">凭注册时使用的那张邀请码</span></p>
    </div>
    <ul class="features">
      <li>邀请码即找回凭证，无需邮箱</li>
      <li>重置后其他设备自动退出</li>
      <li>作品与设定不受影响</li>
    </ul>
  </section>
  <section class="stage">
    <div class="card">
      ${done ? `
        <p style="font-size:13px;line-height:1.8;color:#3d6b36;background:#f0f7ef;border:1px solid #cfe5cb;border-radius:8px;padding:10px 12px">
          <strong>${escapeHtml(name)}</strong> 的密码已重置。<br>
          为安全起见，其他设备上的登录已全部退出，请使用新密码重新登录。
        </p>
        <a class="guestBtn" href="/" style="margin-top:16px">返回登录</a>
      ` : `
      <form id="form" autocomplete="on">
        <label for="name">用户名</label>
        <input id="name" name="name" required maxlength="24" autocomplete="username" placeholder="注册时填的用户名">

        <label for="invite">邀请码</label>
        <input id="invite" name="invite" required maxlength="32" placeholder="注册时使用的那张 8 位邀请码"
               style="text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">

        <label for="pwd">新密码</label>
        <input id="pwd" name="password" type="password" required minlength="6" maxlength="128"
               autocomplete="new-password" placeholder="至少 6 位，请设一个没用过的新密码">

        <button class="submit" id="btn" type="submit">重置密码</button>
        <button class="cancel" id="cancel" type="button" hidden>停止等待</button>
      </form>
      <div class="msg ${msgClass}" id="msg" tabindex="-1" role="alert">${msgText}</div>
      <div class="resetNote">
        邀请码是注册账号时使用的那张（由站主发放）。<br>
        重置成功后：其他设备的登录会全部退出，<strong style="color:#6b6459">全部作品与设定不受影响</strong>。<br>
        若邀请码也忘了，请联系站主（QQ 交流群 / 公众号）人工核实后重置。
      </div>
      `}
    </div>
    <div class="foot"><a href="/" style="color:#8a6d1f;text-decoration:none">返回登录</a></div>
  </section>
</div>
${done ? '' : `<script>(${authClient.toString()})({reset:true});</script>`}
</body>
</html>`
}
