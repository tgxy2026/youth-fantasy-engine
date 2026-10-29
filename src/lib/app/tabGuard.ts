// Presentation only: conditional writes remain the authority; dismissing this notice never unlocks writes.
import { WEB, WEB_CLOUD, WEB_GUEST } from '@/lib/app/platform'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { showNativeNotice, removeNativeNotice } from './nativeNotices'
import { subscribeStorageContext } from '@/lib/storage/contextEpoch'
const CHANNEL = 'yfe-web-tab-guard'
let installed = false
export function installWebTabGuard(): void {
  if ((!WEB && !PORTABLE) || typeof BroadcastChannel === 'undefined' || installed) return
  installed = true
  const selfId = Math.random().toString(36).slice(2), peers = new Map<string, number>(), dismissed = new Set<string>()
  let channel: BroadcastChannel | null = null, timer: ReturnType<typeof setInterval> | null = null
  const scope = () => WEB_CLOUD ? 'cloud:' + ((window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id ?? 'unknown')
    : WEB_GUEST ? 'guest-local' : 'portable'
  let activeScope = scope()
  const refresh = () => {
    if (activeScope !== scope()) { activeScope = scope(); peers.clear() }
    for (const [id, last] of peers) if (Date.now() - last > 16000) peers.delete(id)
    if (!peers.size || dismissed.has(activeScope)) { removeNativeNotice('yfe-tab-guard'); return }
    const text = WEB_CLOUD
      ? '检测到另一个窗口也在用这个账号：两边都是整库保存，云端会拒绝旧版本。发生冲突时请先导出草稿，再重新打开并合并。建议只留一个窗口编辑。'
      : WEB_GUEST
        ? '检测到另一个窗口也在使用本机浏览器资料。请避免同时修改相同内容，先导出备份；建议只留一个窗口编辑。'
        : '检测到另一个窗口也在用这份数据：两边都是整库保存，旧版本会被拒绝。发生冲突时请先导出草稿，再重新打开并合并。建议只留一个窗口编辑。'
    showNativeNotice('yfe-tab-guard', text, '关闭多窗口提示', () => { dismissed.add(activeScope) })
  }
  const send = (type: string) => { try { channel?.postMessage({ type, from: selfId, scope: scope() }) } catch { /* Optional channel. */ } }
  const start = () => {
    refresh()
    if (channel) return
    try { channel = new BroadcastChannel(CHANNEL) } catch { return }
    channel.onmessage = (event: MessageEvent) => {
      const value = event.data as { type?: string; from?: string; scope?: string } | null
      if (!value || typeof value.from !== 'string' || value.from.length > 128 || value.from === selfId || value.scope !== scope()) return
      if (!['hello', 'here', 'pulse', 'bye'].includes(value.type ?? '')) return
      if (value.type === 'bye') peers.delete(value.from)
      else peers.set(value.from, Date.now())
      refresh(); if (value.type === 'hello') send('here')
    }
    send('hello'); timer = setInterval(() => { refresh(); send('pulse') }, 5000)
  }
  const stop = () => {
    send('bye'); channel?.close(); channel = null
    if (timer) clearInterval(timer); timer = null; peers.clear(); refresh()
  }
  start(); window.addEventListener('pagehide', stop); window.addEventListener('pageshow', start)
  window.addEventListener('storage', refresh); subscribeStorageContext(refresh)
}
