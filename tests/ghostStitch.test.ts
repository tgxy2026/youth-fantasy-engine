// ============ 伴写前文拼上一章（stitchGhostBefore + orderedChapters，2026-09-28）============
//
// 需求：当前章内容不足 2000 字时，读上一章末尾凑够 2000 字作上文（章首语境）。
// 钉住的行为：
// ① 当前章前文够长 → 原样返回（旧行为零变化，上一章再长也不拼）；
// ② 不足 → 用上一章**末尾**补齐差额（不是开头），总长恰为 GHOST_CONTEXT_CHARS；
// ③ 上一章无正文（第一卷第一章 / 上一章还没写）→ 原样返回，宁缺毋滥；
// ④ 「上一章」按全书卷章顺序（orderedChapters）——跨卷时是上一卷的最后一章，不是同卷上一章。
import type { Chapter, Volume } from '../src/lib/types'
import { GHOST_CONTEXT_CHARS, orderedChapters, scanRefHighlight, stitchGhostBefore } from '../src/components/editor/novelEditorHelpers'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mkVol = (id: string, order: number): Volume =>
  ({ id, projectId: 'p', order, title: `卷${order + 1}`, description: '', createdAt: 0 })
const mkCh = (id: string, volumeId: string, order: number, content = ''): Chapter =>
  ({ id, projectId: 'p', volumeId, order, title: id, content, summary: '', createdAt: 0, updatedAt: 0 }) as Chapter

// ---------- orderedChapters：全书顺序 ----------
{
  const vols = [mkVol('v2', 1), mkVol('v1', 0)]
  const chs = [
    mkCh('c22', 'v2', 1, '卷二第二章'),
    mkCh('c11', 'v1', 0, '卷一第一章'),
    mkCh('c21', 'v2', 0, '卷二第一章'),
    mkCh('c12', 'v1', 1, '卷一第二章'),
  ]
  const flat = orderedChapters(vols, chs)
  ok('全书顺序：卷按 order、卷内章按 order（与传入顺序无关）',
    flat.map(c => c.id).join(',') === 'c11,c12,c21,c22', flat.map(c => c.id).join(','))
  ok('跨卷「上一章」＝上一卷最后一章（c21 的上一章是 c12）', flat[flat.findIndex(c => c.id === 'c21') - 1].id === 'c12')
  ok('第一卷第一章没有上一章（idx=0）', flat.findIndex(c => c.id === 'c11') === 0)

  // orphan（卷已删 / 无卷）垫底，与 ExportFormatDialog.flattenAll 同口径（审计 2026-09-28 修正）
  const flat2 = orderedChapters(vols, [...chs, mkCh('c99', 'v-gone', 5, '孤儿章')])
  ok('未分卷章节（指向已删卷）垫底在末尾', flat2[flat2.length - 1].id === 'c99')
  ok('orphan 垫底不影响卷内顺序', flat2.map(c => c.id).join(',') === 'c11,c12,c21,c22,c99', flat2.map(c => c.id).join(','))
}

// ---------- stitchGhostBefore：拼接规则 ----------
{
  const prevTail = '前'.repeat(3000)          // 上一章末尾截出的 ≤2000 字
  const long = '正'.repeat(GHOST_CONTEXT_CHARS)
  ok('当前章前文够长 → 原样返回（旧行为零变化）', stitchGhostBefore(long, prevTail) === long)

  const cur = '本'.repeat(600)
  const stitched = stitchGhostBefore(cur, prevTail)
  ok('不足 2000 → 补齐后总长恰为 GHOST_CONTEXT_CHARS', stitched.length === GHOST_CONTEXT_CHARS, String(stitched.length))
  ok('补的是上一章的末尾（不是开头）', stitched === prevTail.slice(-(GHOST_CONTEXT_CHARS - 600)) + cur)
  ok('当前章内容原样排在末段且不被截断', stitched.endsWith(cur))

  ok('上一章比差额短 → 全部拼入', stitchGhostBefore('a'.repeat(1990), '上一章很短') === '上一章很短' + 'a'.repeat(1990))
  ok('上一章为空串 → 原样返回（第一卷第一章/上一章没写）', stitchGhostBefore('当前章', '') === '当前章')
  ok('章首为空 → 全部来自上一章末尾', stitchGhostBefore('', prevTail) === prevTail.slice(-GHOST_CONTEXT_CHARS))
  ok('自定义 limit 生效', stitchGhostBefore('x'.repeat(8), 'y'.repeat(100), 10) === 'yy' + 'x'.repeat(8))
}

// ---------- scanRefHighlight：模型输出含 HTML/脚本也不许变成真标签（AC27，2026-10-28）----------
//
// 高亮叠层是**全仓唯一** `dangerouslySetInnerHTML`：模型输出被粘进正文后，若这里不转义，
// `<img onerror>` / `<script>` 就会在编辑器里真的执行。锁死这条：
{
  const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
  const scan = scanRefHighlight(payload, [])
  ok('🔴 无引用名时整段转义：尖括号不进 DOM', scan.html.includes('&lt;img') && !scan.html.includes('<img'))
  ok('🔴 脚本标签同样只当文本', !/<script/i.test(scan.html) && scan.html.includes('&lt;script&gt;'))
  ok('🔴 转义只做一次（&lt; 不会二次转义成 &amp;lt;）', scanRefHighlight('&lt;', []).html === '&amp;lt;')

  const withRef = scanRefHighlight('陈渊<img src=x>李四', ['陈渊'])
  ok('🔴 命中引用名的 mark 是唯一真标签，其余仍转义',
    withRef.html.startsWith('<mark class="ref-mark">陈渊</mark>') && withRef.html.includes('&lt;img src=x&gt;')
    && (withRef.html.match(/<[a-z]/gi) ?? []).length === 1)
  ok('命中集合只收引用名，不被 HTML 串污染', withRef.hits.size === 1 && withRef.hits.has('陈渊'))

  // 超长正文走「只读纯文本」降级路径，同样必须转义（这是最容易被漏掉的分支）
  const huge = '<b>x</b>'.repeat(12000)
  ok('超长正文降级路径也转义', huge.length > 60000 && !scanRefHighlight(huge, ['陈渊']).html.includes('<b>'))

  // 引用名本身含正则元字符时不能把扫描搞崩（名字是作者填的，可能带 . * ( ) ）
  const meta = scanRefHighlight('a.b 与 a*b', ['a.b', 'a*b'])
  ok('引用名带正则元字符仍精确匹配', meta.hits.has('a.b') && meta.hits.has('a*b'))
}

console.log(`\nghostStitch: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
