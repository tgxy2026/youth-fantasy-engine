// 3.3.2 · 老板键 · 单测 + 静态契约
//
// 盯六件事：
//   ① 组合键规范化与 Electron 主进程的写法一致（两份实现不许漂移）；
//   ② 裸键（F9 / A）必须判非法 —— 那会抢系统或其他程序的键；
//   ③ 页内匹配对修饰键要求严格（多按一个 shift 就不该触发）；
//   ④ 输入法组合中不触发（中文候选键不能把页面遮住）；
//   ⑤ 主进程退出必须释放热键、隐藏前必须先申请成功（否则藏了没入口）；
//   ⑥ 遮挡屏必须盖住一切，且**不显示任何作品信息**。
import fs from 'node:fs'
import path from 'node:path'
import {
  BOSS_DEFAULT_ACCEL, BOSS_PRESETS, accelDisplay, matchesAccel, normalizeAccel,
} from '@/lib/app/bossAccel'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

const keyEvent = (over: Partial<{ key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
  key: 'F9', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
  ...over,
})

function main() {
  // ① 规范化
  ok('默认键规范化不变', normalizeAccel('Control+Shift+F9') === 'Control+Shift+F9')
  ok('Ctrl 别名收敛为 Control', normalizeAccel('Ctrl+Shift+F9') === 'Control+Shift+F9', String(normalizeAccel('Ctrl+Shift+F9')))
  ok('大小写不敏感', normalizeAccel('ctrl+shift+f9') === 'Control+Shift+F9', String(normalizeAccel('ctrl+shift+f9')))
  ok('顺序无关（Shift 在前）', normalizeAccel('Shift+Ctrl+F10') === 'Control+Shift+F10', String(normalizeAccel('Shift+Ctrl+F10')))
  ok('字母主键转大写', normalizeAccel('Ctrl+Alt+k') === 'Control+Alt+K', String(normalizeAccel('Ctrl+Alt+k')))
  ok('数字主键可用', normalizeAccel('Ctrl+Shift+1') === 'Control+Shift+1', String(normalizeAccel('Ctrl+Shift+1')))
  ok('Meta 别名收敛为 Command', normalizeAccel('Cmd+K') === 'Command+K', String(normalizeAccel('Cmd+K')))

  // ② 非法组合
  ok('裸 F9 判非法（不许抢系统键）', normalizeAccel('F9') === null, String(normalizeAccel('F9')))
  ok('裸字母判非法', normalizeAccel('K') === null, String(normalizeAccel('K')))
  ok('空串判非法', normalizeAccel('') === null && normalizeAccel(null) === null && normalizeAccel(undefined) === null)
  ok('未知键判非法', normalizeAccel('Ctrl+Shift+Mouse1') === null, String(normalizeAccel('Ctrl+Shift+Mouse1')))
  ok('只有修饰键判非法', normalizeAccel('Ctrl+Shift') === null, String(normalizeAccel('Ctrl+Shift')))

  // ③ 显示
  ok('显示成 Ctrl + Shift + F9', accelDisplay('Control+Shift+F9') === 'Ctrl + Shift + F9', accelDisplay('Control+Shift+F9'))
  ok('非法组合没有显示文本', accelDisplay('F9') === '')

  // ④ 匹配
  ok('完全匹配触发', matchesAccel(keyEvent(), 'Control+Shift+F9'))
  ok('小写设置也能匹配', matchesAccel(keyEvent(), 'ctrl+shift+f9'))
  ok('多按 Alt 不触发', !matchesAccel(keyEvent({ altKey: true }), 'Control+Shift+F9'))
  ok('少按 Shift 不触发', !matchesAccel(keyEvent({ shiftKey: false }), 'Control+Shift+F9'))
  ok('键不对不触发', !matchesAccel(keyEvent({ key: 'F10' }), 'Control+Shift+F9'))
  ok('输入法组合中不触发', !matchesAccel(keyEvent({ isComposing: true }), 'Control+Shift+F9'))
  ok('非法组合不触发', !matchesAccel(keyEvent(), 'F9'))

  // ⑤ 预设
  ok('三个预设都在', BOSS_PRESETS.length === 3 && BOSS_PRESETS.every((p) => normalizeAccel(p.accel) === p.accel))
  ok('默认键在预设里', BOSS_PRESETS.some((p) => p.accel === BOSS_DEFAULT_ACCEL))
  ok('预设互不重复', new Set(BOSS_PRESETS.map((p) => p.accel)).size === 3)

  // ⑥ 静态契约：主进程
  {
    const mainSrc = read('electron/main.cjs')
    const bossSrc = read('electron/bossKey.cjs')
    const preloadSrc = read('electron/preload.cjs')
    ok('主进程注册了三个老板键 IPC', /boss:apply/.test(mainSrc) && /boss:status/.test(mainSrc) && /boss:toggle/.test(mainSrc))
    ok('退出时释放全局热键', /will-quit/.test(mainSrc) && /bossKey\.dispose\(\)/.test(mainSrc))
    ok('preload 暴露 electronBoss 四个口子',
      /electronBoss/.test(preloadSrc) && /apply:/.test(preloadSrc) && /status:/.test(preloadSrc)
      && /toggle:/.test(preloadSrc) && /onChanged:/.test(preloadSrc))
    ok('主进程没有自动抢占快捷键（默认交给用户申请）',
      !/globalShortcut\.register\(/.test(mainSrc) && /globalShortcut\.register\(/.test(bossSrc))
    ok('先注册新键成功后才释放旧键',
      bossSrc.indexOf('globalShortcut.register(next') < bossSrc.indexOf('unregister(current)'),
      String(bossSrc.indexOf('globalShortcut.register(next')) + '/' + String(bossSrc.indexOf('unregister(current)')))
    ok('没有可用快捷键时拒绝隐藏',
      /没有可用的老板键，隐藏后无法恢复/.test(bossSrc))
    ok('隐藏前先通知渲染层保存', /send\(win, \{ hidden: true, saving: true \}\)/.test(bossSrc))
  }

  // ⑦ 静态契约：渲染层
  {
    const appSrc = read('src/App.tsx')
    const overlaySrc = read('src/components/app/BossOverlay.tsx')
    const settingsSrc = read('src/components/app/BossKeySettings.tsx')
    const zSrc = read('src/lib/app/zLayer.ts')
    ok('三个返回分支都挂了遮挡屏', (appSrc.match(/\{bossOverlay\}/g) || []).length === 3,
      String((appSrc.match(/\{bossOverlay\}/g) || []).length))
    ok('桌面隐藏事件会启动保存屏障', /onBossKeyChanged/.test(appSrc) && /runBossSaveBarrier/.test(appSrc))
    ok('遮挡屏用 Z.boss（必须盖住 toast）', /zIndex: Z\.boss/.test(overlaySrc))
    ok('Z 里定义了 boss 层且高于 toast', /boss: 20000/.test(zSrc) && /toast: 10000/.test(zSrc))
    // 只扫渲染部分：文件头注释里为了说明规则会提到"书名"，那不是界面内容
    const overlayJsx = overlaySrc.slice(Math.max(0, overlaySrc.indexOf('return (')))
    ok('遮挡屏不显示作品信息', overlayJsx.length > 0 && !/projectName|chapter|作品名|书名/.test(overlayJsx))
    ok('设置页区分「已保存」与「已生效」', /未生效/.test(settingsSrc) && /applyBossKey/.test(settingsSrc))
    ok('便携/网页文案写明是页面遮挡', /当前页面遮挡/.test(settingsSrc) || /页面遮挡/.test(settingsSrc))
  }

  console.log(`\n▶ bossKey: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()