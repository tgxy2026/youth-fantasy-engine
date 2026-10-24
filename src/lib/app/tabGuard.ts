// ============ 网页版 · 多标签页互斥提示（WEB-02 的前半部分） ============
//
// 【要解决什么】网页版的数据是「整库读入内存 → 改动 → 全量写回」，
// 便携版仍可能整库覆盖；云端服务已接条件写，冲突窗口需要保留草稿再合并。
//
// 本条只负责 BroadcastChannel 提示，不控制写权限。云端的版本保护在服务端和 fileBackend，
// 便携版仍只有提示。允许打开多个窗口对照，云端旧快照提交时再明确拒绝并保留本地草稿。
//
// 【为什么不写进 React】App.tsx 有四处 early-return 分支各自渲染横幅，逐个加容易漏；
// 而这里用原生 DOM 挂一条 fixed 浮层，不占布局、不依赖任何组件树，也不会影响桌面版与便携版
// （非网页版在第一行就返回了）。
import { WEB, WEB_CLOUD } from '@/lib/app/platform'
import { PORTABLE } from '@/lib/storage/fileBackend'

const CHANNEL = 'yfe-web-tab-guard'

/** 同一浏览器里打开过多个标签页后，本次会话内不再重复提示 */
let dismissed = false
let bannerEl: HTMLDivElement | null = null

function showBanner() {
  if (dismissed || bannerEl || typeof document === 'undefined') return

  const wrap = document.createElement('div')
  wrap.id = 'yfe-tab-guard'
  // 内联样式而非 tailwind 类：本文件是 .ts，不经过 JSX/class 扫描，用类名可能被裁掉。
  // 🔴 颜色一律走主题 CSS 变量（`rgb(var(--amber))` 等），**不写裸十六进制** ——
  //    项目闸 ⑨ 要求色值单一真源（docs/结构护栏），硬编码还顺带让暗/亮主题下配色错位。
  wrap.setAttribute('style', [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:80',
    'display:flex',
    'align-items:center',
    'gap:10px',
    // 🔴 `vw` **不随 `<html>` 的 zoom 缩放**：界面缩放设到 132% 时，写 `100vw` 的元素
    //    实际会占 132vw，右侧被视口裁掉（这条与 `foldVh()` 同一口径，2026-10-21 六维审计抓出）。
    //    留白那 32px 不必折 —— 放大一点只是更松，不折 vw 才会溢出。
    'max-width:calc(100vw / var(--ui-zoom, 1) - 32px)',
    'padding:8px 14px',
    'border-radius:999px',
    'background:rgb(var(--ink-950) / .94)',
    'border:1px solid rgb(var(--amber) / .5)',
    'color:rgb(var(--amber-soft))',
    'font-size:12.5px',
    'line-height:1.5',
    'box-shadow:0 8px 28px -10px rgba(0,0,0,.7)',
    "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  ].join(';'))

  const text = document.createElement('span')
  /**
   * Cloud conditional writes now reject stale versions. Portable retains the explicit legacy risk notice.
   */
  text.textContent = WEB_CLOUD
    ? '检测到另一个窗口也在用这个账号：两边都是整库保存，云端会拒绝旧版本。发生冲突时请先导出草稿，再重新打开并合并。建议只留一个窗口编辑。'
    : '检测到另一个窗口也在用这个账号：两边都是整库保存，后保存的会覆盖先保存的，先写的内容会丢失。建议只留一个窗口编辑。'
  text.setAttribute('style', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '知道了'
  closeBtn.setAttribute('style', 'background:none;border:0;color:rgb(var(--amber));cursor:pointer;font-size:12.5px;padding:0 2px;white-space:nowrap;text-decoration:underline;text-underline-offset:2px')
  closeBtn.addEventListener('click', () => {
    dismissed = true
    wrap.remove()
    bannerEl = null
  })

  wrap.appendChild(text)
  wrap.appendChild(closeBtn)
  document.body.appendChild(wrap)
  bannerEl = wrap
}

/**
 * 安装多标签页探测。**网页版与便携版生效**，桌面版调用它是空操作。
 *
 * 🔴 2026-10-18 三端兼容专项审计（concurrency/portable 运行单元）：便携版同样是
 * 「浏览器多标签 + 整库读入内存」，两个标签页互相覆盖的风险与网页版完全一致，
 * 原先只在 WEB 装是审计发现的覆盖缺口 —— 现扩展到便携版（桌面版单进程独占，仍不需要）。
 * 建议在 `main.tsx` 渲染 React 之前调用一次。
 */
export function installWebTabGuard(): void {
  if (!WEB && !PORTABLE) return
  if (typeof BroadcastChannel === 'undefined') return

  const selfId = Math.random().toString(36).slice(2)
  let ch: BroadcastChannel
  try {
    ch = new BroadcastChannel(CHANNEL)
  } catch {
    return // 隐私模式 / 老浏览器可能直接抛错
  }

  ch.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type?: string; from?: string } | null
    if (!m || typeof m !== 'object' || m.from === selfId) return
    if (m.type === 'hello') {
      // 有新窗口打开：自己也要提示（两边都提示，才不会「谁先开谁不知道」）
      showBanner()
      try { ch.postMessage({ type: 'here', from: selfId }) } catch { /* 通道已关 */ }
    } else if (m.type === 'here') {
      showBanner()
    }
  }

  // 主动打招呼：已有窗口回 `here`，于是本窗口知道「我不是唯一一个」
  try { ch.postMessage({ type: 'hello', from: selfId }) } catch { /* 略 */ }

  // 页面卸载时关掉通道（BroadcastChannel 不关会影响 bfcache）
  window.addEventListener('pagehide', () => {
    try { ch.close() } catch { /* 略 */ }
  })
}
