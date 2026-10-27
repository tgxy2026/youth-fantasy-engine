/** A small DOM surface outside React. The server guest notice uses the same host protocol. */
interface NoticeWindow extends Window { __YFE_NOTICE_LAYOUT__?: () => void }
const STYLE = `
#yfe-external-notices{position:sticky;top:0;z-index:80;max-height:35vh;overflow:auto;background:rgb(var(--ink-950,28 26 23));color:rgb(var(--ink-100,232 226 216));font:13px/1.65 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
#yfe-external-notices[hidden]{display:none}
.yfe-native-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid rgb(var(--amber,201 162 39) / .45)}
.yfe-native-notice .notice-text{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.yfe-native-notice :is(a,button){color:rgb(var(--amber,201 162 39));background:transparent;border:1px solid currentColor;border-radius:6px;padding:4px 8px;min-height:32px;font:inherit;cursor:pointer;text-decoration:none}
.yfe-native-notice :is(a,button):focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(forced-colors:active){.yfe-native-notice{border-color:CanvasText}.yfe-native-notice :is(a,button){color:LinkText}}
`
function host() {
  let el = document.getElementById('yfe-external-notices')
  if (!el) {
    el = document.createElement('div'); el.id = 'yfe-external-notices'
    el.setAttribute('role', 'region'); el.setAttribute('aria-label', '运行提示')
    document.body.insertBefore(el, document.getElementById('root') ?? document.body.firstChild)
  }
  if (!document.getElementById('yfe-native-notice-style')) {
    const style = document.createElement('style'); style.id = 'yfe-native-notice-style'; style.textContent = STYLE; document.head.append(style)
  }
  const target = window as NoticeWindow
  if (!target.__YFE_NOTICE_LAYOUT__) {
    const container = el
    const measure = () => {
      container.hidden = ![...container.children].some(child => !(child as HTMLElement).hidden)
      const height = container.hidden ? 0 : container.getBoundingClientRect().height
      const value = height.toFixed(2) + 'px'
      if (document.documentElement.style.getPropertyValue('--yfe-notice-height') !== value)
        document.documentElement.style.setProperty('--yfe-notice-height', value)
    }
    target.__YFE_NOTICE_LAYOUT__ = measure
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(container)
    new MutationObserver(measure).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('resize', measure, { passive: true })
  }
  return el
}
export function removeNativeNotice(id: string) {
  document.getElementById(id)?.remove(); (window as NoticeWindow).__YFE_NOTICE_LAYOUT__?.()
}
export function showNativeNotice(id: string, text: string, closeLabel: string, dismiss: () => void) {
  const container = host()
  if (document.getElementById(id)) return
  const row = document.createElement('section'); row.id = id; row.className = 'yfe-native-notice'
  row.setAttribute('role', 'status')
  const message = document.createElement('span'); message.className = 'notice-text'; message.textContent = text
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '知道了'; close.setAttribute('aria-label', closeLabel)
  close.addEventListener('click', () => { dismiss(); removeNativeNotice(id) })
  row.append(message, close); container.append(row); (window as NoticeWindow).__YFE_NOTICE_LAYOUT__?.()
}
