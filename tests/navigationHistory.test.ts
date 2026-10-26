// ============ 3.3.0 · UX05：有界来源栈 + 返回入口 ============
//
// ① 纯逻辑：有界、去重、自跳不记、标签净化、pop/restore/clear、深拷贝；
// ② 源码静态闸：只有「关联跳转」记来源，侧栏普通导航不记；返回入口不占布局高度。
import fs from 'node:fs'
import path from 'node:path'
import { createNavigationHistory, HISTORY_LIMIT, normalizeEntry, sanitizeLabel, targetKey } from '../src/lib/app/navigationHistory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 有界 ----------
{
  const h = createNavigationHistory(3)
  for (let i = 0; i < 5; i += 1) h.push({ tabId: `tab${i}` }, `第${i}页`)
  ok('🔴 ① 超过上限丢最旧的（有界）', h.size() === 3 && h.list()[0].target.tabId === 'tab2')
  ok('① 栈顶是最后压入的那条', h.top()?.target.tabId === 'tab4')
  const dflt = createNavigationHistory()
  for (let i = 0; i < HISTORY_LIMIT + 4; i += 1) dflt.push({ tabId: `t${i}` }, `p${i}`)
  ok('① 默认上限就是 HISTORY_LIMIT', dflt.size() === HISTORY_LIMIT, `${dflt.size()}`)
}

// ---------- ② 去重与自跳 ----------
{
  const h = createNavigationHistory()
  h.push({ tabId: 'character' }, '角色档案')
  h.push({ tabId: 'character' }, '角色档案')
  ok('🔴 ② 与栈顶同一目标不重复入栈', h.size() === 1)
  h.push({ tabId: 'character' }, '角色档案（换了标签）')
  ok('② 同目标即使标签不同也不重复', h.size() === 1)
  const self = createNavigationHistory()
  self.push({ tabId: 'editor', chapterId: 'c1' }, '同一章')
  ok('② 从 A 跳 A 仍然记一次（A 是"离开的原位"，与目标无关）', self.size() === 1)
  self.push({ tabId: 'editor', chapterId: 'c2' }, '另一章')
  ok('🔴 ② 章不同的同一页签算不同位置', self.size() === 2 && self.top()?.target.chapterId === 'c2')
}

// ---------- ③ 标签净化与目标校验 ----------
{
  ok('🔴 ③ 标签去掉控制字符并压空白', sanitizeLabel('角\u0000色\n档案\t页') === '角 色 档案 页')
  const long = 'x'.repeat(200)
  const cut = sanitizeLabel(long)
  ok('🔴 ③ 超长标签被截断（≤60 且带省略号）', cut.length <= 60 && cut.endsWith('…'), String(cut.length))
  ok('③ 非字符串标签回落为空串（UI 会用「返回上一页」）', sanitizeLabel(undefined as unknown as string) === '')

  ok('🔴 ③ 非法 tabId 不产生记录', normalizeEntry({ tabId: '  ' }, 'x') === null)
  ok('🔴 ③ 章目标只许出现在正文页（路由约束）', normalizeEntry({ tabId: 'character', chapterId: 'c1' } as never, 'x') === null)
  ok('🔴 ③ 行目标不许出现在正文页', normalizeEntry({ tabId: 'editor', rowId: 'r1' } as never, 'x') === null)
  ok('③ 章/行目标可缺省', normalizeEntry({ tabId: 'editor' }, 't')?.target.chapterId === undefined)
  ok('🔴 ③ 键值把章与行分开（不靠标签名拼键）',
    targetKey({ tabId: 'editor', chapterId: 'c1' }) !== targetKey({ tabId: 'editor', chapterId: 'c2' }))
}

// ---------- ④ pop / restore / clear / 订阅 ----------
{
  const h = createNavigationHistory()
  let notified = 0
  const off = h.subscribe(() => { notified += 1 })
  h.push({ tabId: 'a' }, 'A')
  h.push({ tabId: 'b' }, 'B')
  const popped = h.pop()
  ok('🔴 ④ pop 取走栈顶', popped?.target.tabId === 'b' && h.size() === 1)
  ok('④ 订阅者收到变更通知', notified >= 3)
  h.restore(popped!)
  ok('🔴 ④ restore 把失败的返回放回栈顶', h.size() === 2 && h.top()?.target.tabId === 'b')
  h.clear()
  ok('🔴 ④ clear 清空（切项目/换存储上下文时用）', h.size() === 0 && h.top() === null)
  off()
  const before = notified
  h.push({ tabId: 'c' }, 'C')
  ok('④ 退订后不再收到通知', notified === before)
}

// ---------- ⑤ 深拷贝 ----------
{
  const h = createNavigationHistory()
  h.push({ tabId: 'editor', chapterId: 'c1' }, '第一章')
  const list = h.list()
  list[0].target.chapterId = 'hacked'
  list[0].label = 'hacked'
  const again = h.list()[0]
  ok('🔴 ⑤ 外部改返回结果坏不了内部状态', again.target.chapterId === 'c1' && again.label === '第一章')
  const top = h.top()!
  top.target.chapterId = 'hacked2'
  ok('⑤ top 同样是副本', h.top()?.target.chapterId === 'c1')
}

// ---------- ⑥ 源码闸：接线 ----------
{
  const app = read('src/App.tsx')
  const chip = read('src/components/app/BackToSource.tsx')
  const mention = read('src/components/app/MentionPanel.tsx')
  const sheet = read('src/components/world/CharacterSheet.tsx')
  const hook = read('src/lib/app/useNavigationHistory.ts')

  ok('🔴 ⑥ App 用来源栈并渲染返回入口', /useNavigationHistory\(/.test(app) && /<BackToSource /.test(app))
  ok('🔴 ⑥ 关联跳转先记来源再导航',
    /navHistory\.record\(from, label\)[\s\S]{0,120}navigate\(tabId, chapterId, rowId\)/.test(app))
  ok('🔴 ⑥ 侧栏普通导航不记来源（navigate 里没有 record）',
    /const navigate = useCallback\([\s\S]{0,200}navGate\.request/.test(app) && !/const navigate = useCallback\([\s\S]{0,200}navHistory\.record/.test(app))
  ok('🔴 ⑥ 返回前校验目标仍可见，不可见就丢掉这条', /tabVisible\(tab\.id, visCtx\)[\s\S]{0,160}navHistory\.takeBack\(\)/.test(app))
  ok('🔴 ⑥ 切项目/换存储上下文让来源栈作废', /useNavigationHistory\(`\$\{projectId\}:\$\{getStorageContextEpoch\(\)\}`\)/.test(app)
    && /history\.clear\(\)/.test(hook))
  ok('🔴 ⑥ 返回入口不占布局高度（sticky + 零高 + 绝对定位）',
    /sticky top-0 z-30 h-0/.test(app) && /absolute right-3 top-3/.test(chip))
  ok('🔴 ⑥ 返回按钮可键盘聚焦（原生 button + 标题说明）', /<button[\s\S]{0,200}type="button"/.test(chip) && /title=/.test(chip))
  ok('🔴 ⑥ 角色页把关联跳转透传给提及面板（并补上来源卡 id）',
    /onNavigateReference=\{onNavigateReference/.test(sheet) && /onNavigateReference/.test(mention) && /draft\?\.id/.test(sheet))
  ok('🔴 ⑥ 没有关联跳转回调时退回普通跳转（不静默失效）', /else onNavigate\('editor', h\.chapterId\)/.test(mention))
  ok('🔴 ⑥ 三处共用同一个「关联跳转」类型（不许各写一套签名）',
    /export type NavigateToReference/.test(read('src/lib/app/navigation.ts'))
      && /onNavigateReference\?: NavigateToReference/.test(sheet)
      && /onNavigateReference\?: NavigateToReference/.test(mention))
  ok('🔴 ⑥ 源记录 id 走第 5 参（传成第 4 参会被当成行目标而静默不跳）',
    /onNavigateReference\(tabId, label, chapterId, undefined, draft\?\.id\)/.test(sheet))
  ok('🔴 ⑥ App 的关联跳转接收 5 参并优先用显式源记录',
    /navigateToReference = useCallback\(\(tabId: string, label: string, chapterId\?: string, rowId\?: string, sourceObjectId\?: string\)/.test(app)
      && /sourceObjectId \?\? focusRowId/.test(app))
  ok('🔴 ⑥ 来源栈不写 localStorage / sessionStorage', !/localStorage|sessionStorage/.test(read('src/lib/app/navigationHistory.ts')))
  ok('🔴 ⑥ 来源栈不存正文（只有 tabId/chapterId/rowId/label）',
    !/content|draft|prose/.test(read('src/lib/app/navigationHistory.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
}

console.log(`\n———— navigationHistory：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
