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
import { readFileSync } from 'node:fs'

const PARTY_ART = readFileSync(new URL('./auth-party.jpg', import.meta.url)).toString('base64')

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


/**
 * @param {{mode:'invite'|'open'|'closed', notice?:string, error?:string}} opts
 */
export function renderAuthPage({ mode = 'invite', notice = '', error = '' } = {}) {
  const canRegister = mode !== 'closed'
  const needInvite = mode === 'invite'
  /**
   * 3.5.0：开放注册模式下邀请码是**可选**的云端同步资格凭证。
   * 🔴 必须仍然把输入框留在页面上：老用户手里有码、想一步开通同步，
   *    如果藏起来就等于逼他注册完再找运营；但绝不能设 required，
   *    否则「无码也能注册」这句话就是假的。
   */
  const optionalInvite = mode === 'open'
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
      <img class="party-art" src="data:image/jpeg;base64,${PARTY_ART}" alt="八位 AI 灵感伙伴围坐茶桌，分享创作灵感的非官方插画" width="1774" height="887">
      <p class="art-credit">非官方同人插画 · 角色参考：<a href="https://selinlee.github.io/ai-moe-atlas/zh/" target="_blank" rel="noopener noreferrer">AI 萌化百科与原作者</a></p>
    </div>
    <div class="brand-foot"><span>作品与设定各自独立 · 灵感有迹可循</span><span aria-hidden="true">✦</span></div>
  </section>
  <section class="stage" aria-labelledby="form-title">
    <div class="card">
      <header><p class="card-kicker" lang="en">YOUR NEXT CHAPTER</p><h2 id="form-title">欢迎回来</h2><p class="card-subtitle" id="form-subtitle">继续你的幻想世界之旅。</p></header>
      <a class="guestBtn" href="/guest">免费以游客身份开始创作 ${ARROW}</a>
      <p class="guestNote">无需注册，功能完整。数据保存在<b>当前浏览器</b>，清理浏览器数据或换设备后无法找回，请及时导出备份。</p>
      <div class="orDivider"><span>已有云端账号 / 注册账号</span></div>
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
          <label for="invite">邀请码${optionalInvite ? '（可选）' : ''}</label>
          <input id="invite" name="invite" maxlength="32" autocapitalize="none" spellcheck="false" aria-describedby="invite-note invite-error" placeholder="${optionalInvite ? '有邀请码可同时开通云端同步，没有可留空' : '输入站主发放的邀请码'}">
          <p class="field-note" id="invite-note">${optionalInvite ? '没有邀请码也能注册并参与投稿广场；邀请码用于开通云端作品同步与找回密码，请妥善保管。' : '邀请码也是找回密码的凭证，请妥善保管。'}</p>
          <p class="field-error" id="invite-error" hidden></p>
        </div>

        <div class="forgot"><a href="/reset">忘记密码？</a></div>
        <button class="submit secondary" id="btn" type="submit">进入创作空间</button>
        <button class="cancel" id="cancel" type="button" hidden>停止等待</button>
      </form>

      <div class="msg ${msgClass}" id="msg" tabindex="-1" role="${error ? 'alert' : 'status'}">${msgText}</div>

      ${canRegister && needInvite ? '<p class="invite-info">打赏支持后，可通过 QQ 群 1106815480 或联系开发者 QQ 1822304733 领取邀请码，注册账号即可使用默认 200 MB 云端空间并跨设备访问。邀请码也是找回密码的凭证，请妥善保管。</p>' : ''}
      ${canRegister && optionalInvite ? '<p class="invite-info">注册只需自选用户名和密码，不需要邀请码；云同步资格由服务端单独开通，未开通也可投稿、评论和参与码字排行。</p>' : ''}
    </div>
    <div class="foot">
      <p class="cloud-note">${CLOUD} 账号数据云端保存，按账号隔离</p>
      <p>每账号默认 200 MB 空间 · 可随时导出全部数据</p>
      <div class="dl"><a href="${GITEE_RELEASES_URL}" target="_blank" rel="noreferrer noopener">${DOWNLOAD} 下载桌面版 / 便携版</a></div>
      <p>离线创作 · 支持导出 PDF</p>
    </div>
  </section>
</main>

<script>(${authClient.toString()})({canRegister:${canRegister},needInvite:${needInvite},optionalInvite:${optionalInvite}});</script>
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

  // 3.5.1 · U5：与登录页共用 AUTH_STYLE / auth-entry 视觉语言（原独立金/米 + 深紫面板已删除）。
  // 🔴 只换外观：表单 id / name / autocomplete 与 authClient({reset:true}) 一个不动，找回逻辑不变。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>重置密码 · 青春幻想引擎</title>
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
      <p class="eyebrow" lang="en">FIND YOUR WAY BACK</p>
      <h1 id="brand-title">换一把钥匙，<br><span>回到你的宇宙。</span></h1>
      <p class="story-lead">${done ? '新密码已经生效。' : '邀请码或找回码，任选其一。'}</p>
      <p class="story-note">重置后其他设备自动退出，<br>作品与设定不受影响。</p>
    </div>
    <div class="brand-foot"><span>邀请码即找回凭证 · 无需邮箱</span><span aria-hidden="true">✦</span></div>
  </section>
  <section class="stage" aria-labelledby="form-title">
    <div class="card">
      <header><p class="card-kicker" lang="en">ACCOUNT RECOVERY</p><h2 id="form-title">重置密码</h2><p class="card-subtitle" id="form-subtitle">${done ? '其他设备上的登录已全部退出。' : '凭注册时使用的邀请码，或站主发放的找回码。'}</p></header>
      ${done ? `
        <div class="msg ok" id="msg" role="status">
          <strong>${escapeHtml(name)}</strong> 的密码已重置。<br>
          请使用新密码重新登录；为安全起见，其他设备上的登录已全部退出。
        </div>
        <a class="guestBtn" href="/" style="margin-top:16px">返回登录</a>
      ` : `
      <form id="form" autocomplete="on" aria-labelledby="form-title">
        <label for="name">用户名</label>
        <input id="name" name="name" required maxlength="24" autocomplete="username" placeholder="注册时填的用户名">

        <label for="invite">邀请码</label>
        <input id="invite" name="invite" maxlength="32" placeholder="注册时使用的那张 8 位邀请码（没有可留空）"
               style="text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">

        <label for="recovery">找回码（无邀请码账号）</label>
        <input id="recovery" name="recovery" maxlength="32" placeholder="站主人工核实后发放的一次性找回码"
               style="text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">

        <label for="pwd">新密码</label>
        <input id="pwd" name="password" type="password" required minlength="6" maxlength="128"
               autocomplete="new-password" placeholder="至少 6 位，请设一个没用过的新密码">

        <button class="submit" id="btn" type="submit">重置密码</button>
        <button class="cancel" id="cancel" type="button" hidden>停止等待</button>
      </form>
      <div class="msg ${msgClass}" id="msg" tabindex="-1" role="alert">${msgText}</div>
      <div class="resetNote">
        <strong>邀请码</strong>：注册账号时使用的那张（由站主发放）。<br>
        <strong>找回码</strong>：开放注册、没有邀请码的账号，请联系站主（QQ 交流群 / 公众号）
        说明账号与注册时间，人工核实后领取一次性找回码；找回码 24 小时内有效，只能使用一次。<br>
        重置成功后：其他设备的登录会全部退出，<strong>全部作品与设定不受影响</strong>。
      </div>
      `}
    </div>
    <div class="foot"><a href="/">返回登录</a></div>
  </section>
</main>
${done ? '' : `<script>(${authClient.toString()})({reset:true});</script>`}
</body>
</html>`
}
