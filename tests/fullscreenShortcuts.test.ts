// ============ B2 真·全屏切换：快捷键判定与开关 helpers ============
//
// 只测**渲染层可测的部分**（desktop.ts 的 helpers）：
//  · 无窗口桥（浏览器 / 便携版 / node）→ 一切 no-op：toggle 返回 null、安装返回空函数；
//  · 有窗口桥（mock window）→ F11 切换、ESC 仅在全屏时退出、卸载后按键不再响应。
// 主进程 IPC / preload 注入的联通性走实机验证（冒烟 + 装包手测），不在 node 单测范围。
import { toggleFullscreen, installFullscreenShortcuts } from '../src/lib/desktop'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 可控的假事件（node 没有 KeyboardEvent） */
type FakeKey = { key: string; preventDefault: () => void }

interface MockApi {
  calls: string[]
  fullscreen: boolean
}

/** 注入 mock window，返回 { api, keydown, dispatch }；uninject() 恢复无 window 环境 */
function inject() {
  const api: MockApi = { calls: [], fullscreen: false }
  let keydown: ((e: FakeKey) => void) | null = null
  let added = 0
  const mockWindow = {
    electronWindow: {
      setFullScreen: async (on: boolean) => {
        api.calls.push(`set:${on}`)
        api.fullscreen = on
        return on
      },
      isFullscreen: async () => {
        api.calls.push('get')
        return api.fullscreen
      },
      onFullscreenChange: (_cb: (on: boolean) => void) => () => {},
    },
    addEventListener: (_t: string, fn: (e: FakeKey) => void) => { keydown = fn; added++ },
    removeEventListener: (_t: string, fn: (e: FakeKey) => void) => { if (keydown === fn) keydown = null; added-- },
  }
  ;(globalThis as { window?: unknown }).window = mockWindow
  return {
    api,
    keydown: () => keydown,
    added: () => added,
    /** 按一个键并等微任务排空（helpers 内部是 fire-and-forget 的 promise）；监听器已卸载时静默跳过 */
    async press(key: string) {
      const fn = keydown // 🔴 闭包变量本身就是监听器（onKey）；写成 keydown() 会无参调用它
      if (!fn) return
      fn({ key, preventDefault: () => {} })
      await new Promise(r => setTimeout(r, 0))
    },
    uninject() {
      ;(globalThis as { window?: unknown }).window = undefined
    },
  }
}

/** 排空微任务（无 window 环境下调用 helper 后确认没有隐藏副作用） */
const flush = () => new Promise(r => setTimeout(r, 0))

async function main() {
  // ---- ① 无窗口桥：全部 no-op（node 环境 window 本就 undefined）----
  ok('① 无桥 toggle 返回 null', (await toggleFullscreen()) === null)
  const uninstall = installFullscreenShortcuts()
  ok('① 无桥 install 返回可调用卸载函数', typeof uninstall === 'function')
  uninstall() // 不应抛
  ok('① 无桥卸载不抛', true)

  // ---- ② 有桥：F11 进全屏、再按退出 ----
  const t = inject()
  const off = installFullscreenShortcuts()
  ok('② 已在 window 上注册 keydown（恰好一个）', t.added() === 1)
  await t.press('F11')
  ok('② F11 → setFullScreen(true)', t.api.calls.includes('set:true'), t.api.calls.join(','))
  ok('② 全屏态为 true', t.api.fullscreen === true)
  await t.press('F11')
  ok('② 再按 F11 → setFullScreen(false)', t.api.calls.includes('set:false'), t.api.calls.join(','))

  // ---- ③ ESC：仅全屏时退出；非全屏时不碰（不干扰弹窗关闭语义） ----
  t.api.calls.length = 0
  t.api.fullscreen = false
  await t.press('Escape')
  ok('③ 非全屏按 ESC → 只查询、不退出（ESC 查态属正常行为）',
    !t.api.calls.some(c => c.startsWith('set:')), t.api.calls.join(','))
  t.api.fullscreen = true
  await t.press('Escape')
  ok('③ 全屏按 ESC → 退出', t.api.calls.includes('set:false'), t.api.calls.join(','))

  // ---- ④ 卸载后按键不再响应 ----
  off()
  ok('④ 卸载已移除 keydown 监听', t.added() === 0)
  t.api.calls.length = 0
  await t.press('F11')
  await flush()
  ok('④ 卸载后按 F11 无副作用', t.api.calls.length === 0, t.api.calls.join(','))

  // ---- ⑤ toggleFullscreen 直调：读当前态取反（不经过按键监听） ----
  t.api.calls.length = 0
  t.api.fullscreen = false
  const r = await toggleFullscreen()
  ok('⑤ toggle 读 false → set true，返回 true', r === true && t.api.calls.includes('set:true'), t.api.calls.join(','))

  t.uninject()
  console.log(fail === 0 ? `\n全部通过（${pass}）` : `\n失败 ${fail} / ${pass + fail}`)
  if (fail > 0) process.exit(1)
}

void main()
