// ============ 字体偏好（fontPrefs · 2026-09-28）============
//
// 钉住的行为：
// ① 🔴 sanitizeFontStack 是 CSS 注入防线：setProperty 的值可被 `;` 截断成另一条声明，
//    所以分号 / 大括号 / 尖括号 / 反斜杠等必须剥掉 —— 洗完为空返回 ''（按跟随默认处理）；
// ② fontStackLabel：从栈段提取展示名（去引号取第一段）；
// ③ 预置清单结构合法（name / stack 非空、stack 本身不含注入字符）；
// ④ getStoredFontPrefs 脏数据逐字段收窄（超长 / 注入字符 → 该字段回默认）；
// ⑤ applyFontPrefs 在无 document 环境（node）下静默跳过 —— 与 theme.ts 同口径。
import {
  PRESET_FONTS, sanitizeFontStack, fontStackLabel,
  getStoredFontPrefs, applyFontPrefs, applyStoredFontPrefs, storeFontPrefs,
} from '../src/lib/settings/fontPrefs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① sanitizeFontStack ----------
{
  ok('合法家族名原样保留', sanitizeFontStack('楷体') === '楷体')
  ok('英文注册名 + 空格保留', sanitizeFontStack('Microsoft YaHei') === 'Microsoft YaHei')
  ok('栈段（含逗号与引号）保留', sanitizeFontStack('"楷体", KaiTi') === '"楷体", KaiTi')
  ok('🔴 分号被剥（声明截断 / CSS 注入）', sanitizeFontStack('楷体; color: red') === '楷体 color red', sanitizeFontStack('楷体; color: red'))
  ok('🔴 大括号被剥（规则块注入）', sanitizeFontStack('a} body { color: red') === 'a body  color red')
  ok('🔴 尖括号被剥（HTML 注入面）', sanitizeFontStack('<script>') === 'script')
  ok('🔴 反斜杠被剥', sanitizeFontStack('a\\b') === 'ab')
  ok('纯非法字符 → 空串', sanitizeFontStack(';;;{}<>') === '')
  ok('空串 → 空串', sanitizeFontStack('') === '')
  ok('undefined 容错 → 空串', sanitizeFontStack(undefined as unknown as string) === '')
}

// ---------- ② fontStackLabel ----------
{
  ok('去引号取第一段', fontStackLabel('"楷体", KaiTi') === '楷体')
  ok('无引号栈段取首段', fontStackLabel('Microsoft YaHei, Segoe UI') === 'Microsoft YaHei')
  ok('空串 → 空串', fontStackLabel('') === '')
}

// ---------- ③ 预置清单 ----------
{
  ok('预置清单非空', PRESET_FONTS.length >= 6)
  ok('每项 name / stack 非空且 stack 过得了自家的清洗（合法家族名）',
    PRESET_FONTS.every(p => p.name.trim() && p.stack.trim() && sanitizeFontStack(p.stack) !== ''))
  ok('预置栈段不含声明截断符（分号/大括号）',
    PRESET_FONTS.every(p => !/[;{}]/.test(p.stack)))
  ok('默认正文（思源宋体）与默认界面（思源黑体）都在清单里',
    PRESET_FONTS.some(p => p.stack.includes('Noto Serif SC')) && PRESET_FONTS.some(p => p.stack.includes('Noto Sans SC')))
}

// ---------- ④ getStoredFontPrefs 脏数据收窄（mock localStorage） ----------
{
  const g = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
  const withStore = (v: string | null) => {
    g.localStorage = { getItem: () => v, setItem: () => {}, removeItem: () => {} }
  }
  try {
    withStore(null)
    ok('无存储 → 全默认（空串 = 跟随默认）',
      JSON.stringify(getStoredFontPrefs()) === JSON.stringify({ editor: '', ui: '' }))
    withStore('not json at all {')
    ok('脏 JSON → 全默认', getStoredFontPrefs().editor === '' && getStoredFontPrefs().ui === '')
    withStore(JSON.stringify({ editor: '楷体', ui: 'x;' }))
    const dirty = getStoredFontPrefs()
    ok('合法字段保留、注入字段回默认', dirty.editor === '楷体' && dirty.ui === '')
    withStore(JSON.stringify({ editor: 'x'.repeat(201), ui: '宋体' }))
    const long = getStoredFontPrefs()
    ok('超长字段（>200）回默认', long.editor === '' && long.ui === '宋体')
    withStore(JSON.stringify({ editor: 42, ui: null }))
    ok('非字符串字段回默认', getStoredFontPrefs().editor === '' && getStoredFontPrefs().ui === '')
  } finally {
    delete g.localStorage   // 还原，别污染后续用例
  }
}

// ---------- ⑤ 无 document 环境（node）静默跳过 ----------
{
  applyFontPrefs({ editor: '楷体', ui: '' })       // 不抛即过
  applyStoredFontPrefs()
  storeFontPrefs({ editor: '', ui: '' })
  ok('apply / store 系列在 node 环境下不抛（document 守卫生效）', true)
}

console.log(`\nfontPrefs: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
