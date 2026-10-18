// ============ 服务端渲染的登录 / 注册页 ============
//
// 【为什么由服务端出页面，而不是让前端渲染】前端是纯静态 SPA，未登录时它一启动就去请求
// /api/data，拿到 401 只会挂写盘锁、弹出技术性红条 —— 作者看到的是「数据读取失败」，
// 而不是「请先登录」。服务端这一层直接把人挡在门口，前端代码可以一个字节都不改。
//
// 🔴 所有回显内容（用户名、错误提示）一律转义：登录页同样会被 XSS 打。
import { GITEE_RELEASES_URL } from './config.mjs'

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:#f7f4ee;color:#2c2c2a;
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{width:100%;max-width:400px}
.brand{text-align:center;margin-bottom:26px}
.brand h1{font-size:21px;font-weight:600;letter-spacing:.06em;color:#1f1d1a}
.brand p{margin-top:7px;font-size:12.5px;color:#8a8279;letter-spacing:.04em}
.card{background:#fff;border:1px solid #e8e1d5;border-radius:14px;padding:26px 24px 22px;
  box-shadow:0 1px 2px rgba(60,48,30,.04),0 8px 24px -12px rgba(60,48,30,.12)}
.tabs{display:flex;gap:6px;margin-bottom:20px;background:#f3efe7;padding:4px;border-radius:9px}
.tabs button{flex:1;padding:8px 0;border:0;border-radius:6px;background:transparent;cursor:pointer;
  font-size:13px;color:#7c7468;font-family:inherit;transition:background .15s,color .15s}
.tabs button.on{background:#fff;color:#1f1d1a;font-weight:500;box-shadow:0 1px 3px rgba(60,48,30,.1)}
label{display:block;font-size:12.5px;color:#6b6459;margin:14px 0 6px;letter-spacing:.03em}
input{width:100%;padding:10px 12px;font-size:14px;font-family:inherit;color:#2c2c2a;
  background:#fdfcfa;border:1px solid #e0d8ca;border-radius:8px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#c9a227;box-shadow:0 0 0 3px rgba(201,162,39,.12)}
button.submit{width:100%;margin-top:22px;padding:11px 0;font-size:14px;font-family:inherit;font-weight:500;
  color:#fff;background:#8a6d1f;border:0;border-radius:8px;cursor:pointer;letter-spacing:.06em;transition:background .15s}
button.submit:hover{background:#755c19}
button.submit:disabled{background:#b9ab8b;cursor:not-allowed}
.msg{margin-top:14px;padding:9px 12px;font-size:12.5px;line-height:1.6;border-radius:8px;display:none}
.msg.err{display:block;background:#fdf0ee;border:1px solid #f3cfc8;color:#a4342a}
.msg.ok{display:block;background:#f0f7ef;border:1px solid #cfe5cb;color:#3d6b36}
.foot{margin-top:18px;text-align:center;font-size:11.5px;line-height:1.9;color:#9a9084}
.foot b{color:#7c7468;font-weight:500}
.dl{margin-top:14px;padding-top:12px;border-top:1px solid #eee8dc;font-size:11.5px;line-height:1.9;color:#9a9084}
.dl a{color:#8a6d1f;text-decoration:none;border-bottom:1px solid rgba(138,109,31,.35);transition:color .15s,border-color .15s}
.dl a:hover{color:#6b5316;border-bottom-color:#6b5316}
.orDivider{display:flex;align-items:center;gap:10px;margin:18px 0 12px;font-size:11.5px;color:#a89f92}
.orDivider::before,.orDivider::after{content:'';flex:1;height:1px;background:#e8e1d5}
.guestBtn{display:block;text-align:center;padding:10px 0;font-size:13px;color:#6b6459;text-decoration:none;
  border:1px solid #e0d8ca;border-radius:8px;transition:border-color .15s,color .15s,background .15s}
.guestBtn:hover{border-color:#c9a227;color:#8a6d1f;background:#fdfbf5}
.guestNote{margin-top:10px;font-size:11px;line-height:1.75;color:#a89f92;text-align:center}
.guestNote b{color:#8a6d1f;font-weight:500}
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
    ${canRegister ? `<div class="tabs" id="tabs">
      <button type="button" data-tab="login" class="on">登录</button>
      <button type="button" data-tab="register">注册</button>
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
    </form>

    <div class="msg ${msgClass}" id="msg">${msgText}</div>

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

<script>
(function () {
  var mode = 'login'
  var canRegister = ${canRegister ? 'true' : 'false'}
  var needInvite = ${needInvite ? 'true' : 'false'}
  var tabs = document.getElementById('tabs')
  var form = document.getElementById('form')
  var btn = document.getElementById('btn')
  var msg = document.getElementById('msg')
  var inviteBox = document.getElementById('inviteBox')
  var pwd = document.getElementById('pwd')

  function say(text, kind) {
    msg.className = 'msg ' + (kind || 'err')
    msg.textContent = text
  }

  function switchTab(next) {
    mode = next
    if (tabs) {
      for (var i = 0; i < tabs.children.length; i++) {
        tabs.children[i].className = tabs.children[i].dataset.tab === next ? 'on' : ''
      }
    }
    var isReg = next === 'register'
    inviteBox.style.display = (isReg && needInvite) ? 'block' : 'none'
    btn.textContent = isReg ? '注册并登录' : '登录'
    pwd.setAttribute('autocomplete', isReg ? 'new-password' : 'current-password')
    msg.className = 'msg'
    msg.textContent = ''
  }

  if (tabs) {
    tabs.addEventListener('click', function (e) {
      var t = e.target.closest('button[data-tab]')
      if (t) switchTab(t.dataset.tab)
    })
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    if (!canRegister && mode === 'register') return
    var payload = {
      name: document.getElementById('name').value.trim(),
      password: pwd.value
    }
    if (mode === 'register') payload.invite = document.getElementById('invite').value.trim()

    btn.disabled = true
    var original = btn.textContent
    btn.textContent = '请稍候…'

    fetch('/api/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j } })
    }).then(function (res) {
      if (res.status === 200 && res.body && res.body.ok) {
        say('登录成功，正在进入…', 'ok')
        location.replace('/')
        return
      }
      say((res.body && res.body.error) || '操作失败，请重试', 'err')
      btn.disabled = false
      btn.textContent = original
    }).catch(function () {
      say('网络异常，请检查连接后重试', 'err')
      btn.disabled = false
      btn.textContent = original
    })
  })

  if (needInvite) switchTab('login')
})();
</script>
</body>
</html>`
}
