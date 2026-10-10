// 桌面版外置 store（sidecar）单测
//
// 🔴 为什么必须单独立这份（2026-10-11）：`tests/mock-desktop.ts` 把 `desktopStore`
//    **整体替换**成内存桩（Node 里没有 IndexedDB），于是桌面版真实的外置路由
//    在既有测试里**一次都没被走到** —— 与便携版（有 portableVecKb 全链路覆盖）不对称。
//    这里直接测真的 `desktopStore`，配内存外置通道。
//
// 只测外置 store：未外置的 store 会触发 scheduleSave → flushDesktop → 调 window.electronStore
// （Node 里不存在），故刻意避开，避免为测 A 而引入无关的副作用。
import type { SidecarApi } from '../src/lib/storage/sidecar'
import {
  DESKTOP_SIDECAR, desktopStore, setDesktopSidecarApi, resetDesktopSidecarApi,
} from '../src/lib/app/desktop'
import { PORTABLE_SIDECAR } from '../src/lib/storage/fileBackend'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' | ' + extra : ''}`) }
}

const files = new Map<string, unknown>()
const memApi: SidecarApi = {
  async read(store, id) { return files.get(`${store}/${id}`) },
  async write(store, id, v) { files.set(`${store}/${id}`, v); return true },
  async remove(store, id) { return files.delete(`${store}/${id}`) },
  async listIds(store) {
    const p = store + '/'
    return [...files.keys()].filter(k => k.startsWith(p)).map(k => k.slice(p.length))
  },
}
setDesktopSidecarApi(memApi)

// ============ ① 配置：桌面版只外置备份载荷 ============
ok('① 桌面版外置集合只含 backupPayloads',
  JSON.stringify(Object.keys(DESKTOP_SIDECAR)) === '["backupPayloads"]', JSON.stringify(Object.keys(DESKTOP_SIDECAR)))
ok('① 桌面版 backupPayloads 为 per-id 布局', DESKTOP_SIDECAR.backupPayloads.layout === 'per-id')
ok('① 主键字段为 id', DESKTOP_SIDECAR.backupPayloads.keyField === 'id')

// 🔴 同构守卫：两端对「同一 store」的布局必须**逐字一致**，否则会出现
//    「桌面版导出的备份，便携版读不到」这类跨端不一致，且极难排查。
ok('② 两端对 backupPayloads 的布局一致（同构守卫）',
  DESKTOP_SIDECAR.backupPayloads.layout === PORTABLE_SIDECAR.backupPayloads.layout
  && DESKTOP_SIDECAR.backupPayloads.keyField === PORTABLE_SIDECAR.backupPayloads.keyField,
  `${JSON.stringify(DESKTOP_SIDECAR.backupPayloads)} vs ${JSON.stringify(PORTABLE_SIDECAR.backupPayloads)}`)
ok('② 便携版外置集合是桌面版的超集（向量/KB 为便携专属）',
  Object.keys(DESKTOP_SIDECAR).every(k => k in PORTABLE_SIDECAR), JSON.stringify(Object.keys(PORTABLE_SIDECAR)))

// ============ ③ 读写删走外置通道 ============
{
  await desktopStore.put('backupPayloads', { id: 'd1', projectId: 'p1', bundle: { chapters: 3 } })
  ok('③ 写入落到外置通道', files.has('backupPayloads/d1'), [...files.keys()].join(','))
  const got = await desktopStore.get<{ bundle: { chapters: number } }>('backupPayloads', 'd1')
  ok('③ 读回内容一致', got?.bundle?.chapters === 3, JSON.stringify(got))
  const all = await desktopStore.getAll<{ id: string }>('backupPayloads')
  ok('③ getAll 走外置', all.length === 1 && all[0].id === 'd1')
  await desktopStore.del('backupPayloads', 'd1')
  ok('③ 删除走外置', !files.has('backupPayloads/d1'))
  ok('③ 删除后读回 undefined', (await desktopStore.get('backupPayloads', 'd1')) === undefined)
}

// ============ ④ 通道可换（注入点生效）============
{
  const other = new Map<string, unknown>()
  setDesktopSidecarApi({
    async read(s, i) { return other.get(`${s}/${i}`) },
    async write(s, i, v) { other.set(`${s}/${i}`, v); return true },
    async remove(s, i) { return other.delete(`${s}/${i}`) },
    async listIds(s) { const p = s + '/'; return [...other.keys()].filter(k => k.startsWith(p)).map(k => k.slice(p.length)) },
  })
  await desktopStore.put('backupPayloads', { id: 'd2' })
  ok('④ 换通道后写入新通道', other.has('backupPayloads/d2') && !files.has('backupPayloads/d2'))
  // 复位是回到**真实的 IPC 实现**（不是回到上一次注入的那个）—— Node 里没有主进程，
  //    写入会失败，这正是「复位生效」的可观测证据：不再落到注入的通道里。
  resetDesktopSidecarApi()
  await desktopStore.put('backupPayloads', { id: 'd3' })
  ok('④ 复位后不再走注入通道（已切回真实 IPC）', !files.has('backupPayloads/d3') && !other.has('backupPayloads/d3'))
}

console.log(`\ndesktopSidecar: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
