// Serialized into the independent identity pages. No app bundle, library reads or browser persistence.
export function authClient({ reset = false, canRegister = false, needInvite = false }) {
  const form = document.getElementById('form'), btn = document.getElementById('btn')
  const msg = document.getElementById('msg'), cancel = document.getElementById('cancel')
  const tabs = document.getElementById('tabs'), pwd = document.getElementById('pwd'), inviteBox = document.getElementById('inviteBox')
  let mode = reset ? 'reset' : 'login', active = null, succeeded = false
  const title = () => mode === 'reset' ? '重置密码' : mode === 'register' ? '注册并登录' : '登录'
  const say = (text, kind = 'err') => {
    msg.className = 'msg ' + kind; msg.textContent = text
    msg.setAttribute('role', kind === 'err' ? 'alert' : 'status')
    if (kind === 'err') msg.focus({ preventScroll: false })
  }
  const busy = value => {
    form.setAttribute('aria-busy', String(value))
    for (const input of form.querySelectorAll('input')) input.disabled = value
    for (const tab of tabs?.querySelectorAll('button') ?? []) tab.disabled = value
    btn.disabled = value; btn.textContent = value ? '正在提交…' : title(); cancel.hidden = !value
  }
  const switchTab = (next, clearMessage = true) => {
    if (active || succeeded || !['login', 'register'].includes(next) || (next === 'register' && !canRegister)) return
    mode = next
    for (const tab of tabs?.querySelectorAll('button') ?? []) {
      const selected = tab.dataset.tab === next
      tab.className = selected ? 'on' : ''; tab.setAttribute('aria-pressed', String(selected))
    }
    const invite = document.getElementById('invite')
    inviteBox.style.display = next === 'register' && needInvite ? 'block' : 'none'
    invite.required = next === 'register' && needInvite
    btn.textContent = title(); pwd.autocomplete = next === 'register' ? 'new-password' : 'current-password'
    if (clearMessage) { msg.className = 'msg'; msg.textContent = '' }
  }
  tabs?.addEventListener('click', event => {
    const tab = event.target.closest('button[data-tab]'); if (tab) switchTab(tab.dataset.tab)
  })
  cancel.addEventListener('click', () => {
    if (!active) return
    const request = active; active = null; clearTimeout(request.timer); request.controller.abort(); busy(false)
    say('已停止等待响应。服务端可能已处理，请先确认结果，再决定是否重试。', 'ok'); btn.focus()
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (active || succeeded || (!canRegister && mode === 'register')) return
    const payload = { name: document.getElementById('name').value.trim(), password: pwd.value }
    if (mode === 'register' || reset) payload.invite = reset
      ? document.getElementById('invite').value.trim().toUpperCase() : document.getElementById('invite').value.trim()
    const request = { controller: new AbortController(), timer: null, timedOut: false }
    active = request; busy(true); msg.className = 'msg'; msg.textContent = ''
    request.timer = setTimeout(() => { request.timedOut = true; request.controller.abort() }, 30000)
    fetch('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: request.controller.signal })
      .then(async response => ({ status: response.status, body: await response.json() }))
      .then(result => {
        if (active !== request) return
        clearTimeout(request.timer); active = null
        if (result.status === 200 && result.body?.ok) {
          succeeded = true; cancel.hidden = true
          say(reset ? '重置成功，正在返回登录页…' : '登录成功，正在进入…', 'ok')
          if (reset) setTimeout(() => location.replace('/'), 900)
          else location.replace('/')
          return
        }
        busy(false); say(result.body?.error || '操作失败，请重试')
      }).catch(() => {
        if (active !== request) return
        clearTimeout(request.timer); active = null; busy(false)
        say(request.timedOut ? '等待响应超时，服务端可能已处理。请先确认结果，再决定是否重试。' : '网络异常，请检查连接后重试')
      })
  })
  if (!reset) switchTab('login', false)
}
