// ============ 网页版 · 窄屏访问提示（WEB-11） ============
//
// 【为什么要有】界面按桌面设计：三栏、侧栏、左下角数据坞、右下角立绘。
// 手机上打开不是「稍微挤」，而是基本没法用，而此前**没有任何提示** ——
// 用户会在错位的界面上摸索半天，最后得出「这软件不行」的结论。
//
// 这里只做「告知 + 给退路」，**不阻止访问**：
// 游客至少还能导出数据，一刀切拒绝会连带把唯一的备份路径也切掉。
//
// 实现同 tabGuard：原生 DOM + 主题 CSS 变量（色值走 `rgb(var(--…))`，不写裸十六进制，
// 否则会踩结构闸 ⑨），非网页版第一行即返回 ⇒ 桌面 / 便携零影响。
import { WEB } from '@/lib/app/platform'

const DISMISS_KEY = 'yfe-mobile-hint-off'
/** 低于此宽度视为手机/窄窗口 */
const NARROW = 768

function showBanner() {
  if (typeof document === 'undefined') return
  if (document.getElementById('yfe-mobile-hint')) return
  try {
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return
  } catch { /* 隐私模式下读不到就照常提示 */ }

  const wrap = document.createElement('div')
  wrap.id = 'yfe-mobile-hint'
  wrap.setAttribute('style', [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:70',
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'padding:10px 14px',
    'background:rgb(var(--ink-950) / .96)',
    'border-bottom:1px solid rgb(var(--amber) / .45)',
    'color:rgb(var(--amber-soft))',
    'font-size:12px',
    'line-height:1.65',
    "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  ].join(';'))

  const text = document.createElement('span')
  text.textContent = '本工具为长篇写作设计，界面按电脑屏幕布局；手机上建议先用「导出数据」留档，再换电脑访问。'
  text.setAttribute('style', 'flex:1;min-width:0')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '知道了'
  btn.setAttribute('style', 'background:none;border:0;color:rgb(var(--amber));cursor:pointer;font-size:12px;padding:2px 4px;white-space:nowrap;text-decoration:underline;text-underline-offset:2px')
  btn.addEventListener('click', () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* 略 */ }
    wrap.remove()
  })

  wrap.appendChild(text)
  wrap.appendChild(btn)
  document.body.appendChild(wrap)
}

/**
 * 安装窄屏提示。只在网页版生效；桌面版 / 便携版是空操作。
 * 建议在 `main.tsx` 渲染 React 之前调用一次。
 */
export function installMobileHint(): void {
  if (!WEB) return
  if (typeof window === 'undefined') return
  // 首屏即判断；横竖屏切换/窗口缩放时按需补上（只加不清——用户关掉后不该再弹）
  const check = () => { if (window.innerWidth < NARROW) showBanner() }
  check()
  window.addEventListener('resize', check, { passive: true })
}
