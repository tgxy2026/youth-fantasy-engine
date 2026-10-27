// ============ 服务端渲染的登录 / 注册页 ============
//
// 【为什么由服务端出页面，而不是让前端渲染】前端是纯静态 SPA，未登录时它一启动就去请求
// /api/data，拿到 401 只会挂写盘锁、弹出技术性红条 —— 作者看到的是「数据读取失败」，
// 而不是「请先登录」。服务端这一层直接把人挡在门口，前端代码可以一个字节都不改。
//
// 🔴 所有回显内容（用户名、错误提示）一律转义：登录页同样会被 XSS 打。
import { GITEE_RELEASES_URL } from './config.mjs'
import { authClient } from './authClient.mjs'

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;line-height:1.65;
  background:#f7f4ee;color:#2c2c2a;
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{width:100%;min-width:0;max-width:420px;overflow-wrap:anywhere}
.brand{text-align:center;margin-bottom:26px}
.brand h1{font-size:21px;font-weight:600;letter-spacing:.06em;color:#1f1d1a}
.brand p{margin-top:7px;font-size:13px;color:#625b51;letter-spacing:.04em}
.card{background:#fff;border:1px solid #e8e1d5;border-radius:14px;padding:26px 24px 22px;
  box-shadow:0 1px 2px rgba(60,48,30,.04),0 8px 24px -12px rgba(60,48,30,.12)}
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
.dl{margin-top:14px;padding-top:12px;border-top:1px solid #eee8dc;font-size:13px;line-height:1.9;color:#625b51}
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
@media(max-width:360px){.card{padding:20px 16px}.brand{margin-bottom:18px}}
@media(max-height:700px){body{align-items:flex-start}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
@media(forced-colors:active){.card,input,.tabs,button.submit,.cancel,.guestBtn,.msg{border:1px solid CanvasText}button.submit{background:ButtonFace;color:ButtonText}:focus-visible{outline-color:Highlight}}
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>登录 · 青春幻想引擎</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <h1>青春幻想引擎</h1>
    <p>在线创作工作台 · 作品与设定各自独立</p>
  </div>
  <div class="card">
    ${canRegister ? `<div class="tabs" id="tabs" role="group" aria-label="账号操作">
      <button type="button" data-tab="login" class="on" aria-pressed="true">登录</button>
      <button type="button" data-tab="register" aria-pressed="false">注册</button>
    </div>` : ''}

    <form id="form" autocomplete="on">
      <label for="name">用户名</label>
      <input id="name" name="name" required maxlength="24" autocomplete="username" placeholder="2–24 位，可用中文">

      <label for="pwd">密码</label>
      <input id="pwd" name="password" type="password" required minlength="6" maxlength="128"
             autocomplete="current-password" placeholder="至少 6 位">

      <div id="inviteBox" style="display:${needInvite ? 'block' : 'none'}">
        <label for="invite">邀请码</label>
        <input id="invite" name="invite" maxlength="32" placeholder="填写邀请码后注册">
      </div>

      <button class="submit" id="btn" type="submit">登录</button>
      <button class="cancel" id="cancel" type="button" hidden>停止等待</button>
    </form>

    <div class="msg ${msgClass}" id="msg" tabindex="-1" role="${error ? 'alert' : 'status'}">${msgText}</div>

    <div class="forgot"><a href="/reset">忘记密码？可用注册时的邀请码重置</a></div>

    <div class="orDivider"><span>或者</span></div>
    <a class="guestBtn" href="/guest">以游客身份试用</a>
    <p class="guestNote">
      游客数据保存在<b>你自己的浏览器</b>里，不会上传到服务器<br>
      清除浏览器数据、换设备后<b>无法找回</b>，请及时导出备份
    </p>
  </div>
  <div class="foot">
    数据保存在服务器，按账号隔离<br>
    每账号默认 <b>200 MB</b> 空间 · 可随时导出全部数据
  </div>
  <div class="dl">
    想要离线使用、导出 PDF？<a href="${GITEE_RELEASES_URL}" target="_blank" rel="noreferrer noopener">下载桌面版 / 便携版</a>
  </div>
</div>

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
<div class="wrap">
  <div class="brand">
    <h1>重置密码</h1>
    <p>凭注册时使用的那张邀请码</p>
  </div>
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
</div>
${done ? '' : `<script>(${authClient.toString()})({reset:true});</script>`}
</body>
</html>`
}
