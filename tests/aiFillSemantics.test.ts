// ============ 2026-10-03 老大定案：AI 填写入口的「新增 / 补全」语义必须各自名实相符 ============
//
// 起因（老大实机反馈）：三组「AI 填写」入口里，按钮名与实际行为对不上 ——
//   · 开书定位组：制度四页签（政治/经济/信仰/司法）的「保存 + AI 补全」压在右栏最底部，
//     与世界设定 / 力量体系（同在页头）**同组不同形**；
//   · 角色管理组：主要/次要/NPC 角色右上角写着「AI 补全」，点了却是**凭空建一张新卡**；
//   · 世界构建组：表格右上角写着「AI 补全」，实际也是**新建一行**；
//     而真正补空白的是**行首**那个「AI 补全本行空白」。
//
// 定案：右上角「凭空新建」的一律叫 **AI 新增**；「补当前条目空白」的才叫 **AI 补全**（行首 / 表单 / 角色卡）。
// 本测试把这三组的分工与文案钉死，防止以后又被改混。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

function main() {
  // ── ① 角色管理组（CharacterSheet）：AI 新增（建卡）+ AI 补全（补当前卡）两个入口并存 ──
  const cs = read('src/components/CharacterSheet.tsx')
  ok('角色卡右上角同时有「AI 新增」与「AI 补全」', cs.includes('AI 新增') && cs.includes('AI 补全'))
  ok('AI 新增：点开的是新建弹窗 setShowFill(true)', cs.includes('onClick={() => setShowFill(true)}'))
  ok('AI 新增：弹窗标题为「AI 新增 · 页签名」', cs.includes('AI 新增 · ${tab.name}'))
  ok('🔴 AI 补全：新增独立状态 setShowFillExisting(true)', cs.includes('const [showFillExisting, setShowFillExisting] = useState(false)') && cs.includes('onClick={() => setShowFillExisting(true)}'))
  ok('🔴 AI 补全：传 existing={draft.data}（已填字段锁定、只补空白）', cs.includes('existing={draft.data}'))
  ok('🔴 AI 补全：弹窗标题带当前卡名', cs.includes('AI 补全 · ${draft.name}'))
  ok('🔴 AI 补全：未选卡时禁用（!aiReady || !draft）', cs.includes('disabled={!aiReady || !draft}'))
  ok('🔴 AI 补全采用时只写非空字段（已填的保留，与 FormSheet 同口径）',
    /for \(const \[k, v\] of Object\.entries\(values\)\) if \(v && v\.trim\(\)\) next\.data\[k\] = v/.test(cs))
  ok('AI 新增仍走 handleFill（建卡落库），未被改动', cs.includes('onSubmit={handleFill}'))

  // ── ② 世界构建组 + 全项目表格（TableSheet）：右上角「AI 新增」，行首才是「AI 补全本行空白」 ──
  const ts = read('src/components/TableSheet.tsx')
  ok('🔴 表格右上角：organize 显「AI 整理」、fill 显「AI 新增」',
    ts.includes("{aiCap === 'organize' ? 'AI 整理' : 'AI 新增'}"))
  ok('🔴 右上角新建行弹窗标题改为「AI 新增 · 表名」', ts.includes('AI 新增 · ${tab.name}'))
  ok('🔴 行首补空白弹窗标题保持「AI 补全本行空白」（这是真补全）',
    ts.includes('AI 补全本行空白 · ${tab.name}') && ts.includes('existing={fillRow.data}'))
  ok('表格问号说明同步为「AI 整理」或「AI 新增」', ts.includes('「AI 整理」或「AI 新增」'))
  ok('🔴「AI 整理」按钮与链路原样未动', ts.includes("setShowOrganize(true)") && ts.includes('<AIOrganize'))

  const row = read('src/components/TableSheetRow.tsx')
  ok('🔴 行首行内按钮文案未受影响（AI 补全本行空白）', row.includes('AI 补全本行空白'))
  const rel = read('src/components/TableRelationGroups.tsx')
  ok('关系分组里的行内补全提示也保持「AI 补全本行空白」', rel.includes('AI 补全本行空白'))

  // ── ③ 开书定位组（ParallelSetSheet）：保存 + AI 补全挪到页头，与 WorldSetSheet 同形 ──
  const ps = read('src/components/ParallelSetSheet.tsx')
  const ws = read('src/components/WorldSetSheet.tsx')
  ok('🔴 制度四页签页头右端有按钮组（ml-auto flex items-center gap-2）', ps.includes('ml-auto flex items-center gap-2'))
  ok('🔴 页头出现 AI 补全按钮', /<Sparkles size=\{12\} \/> AI 补全/.test(ps))
  ok('🔴 页头出现保存按钮（variant="toggle" + flush）', ps.includes('variant="toggle" selected={dirty}') && ps.includes('onClick={() => void flush()}'))
  ok('🔴 右栏底部那排按钮已撤（不再有两处同功能）', !ps.includes('底部：AI 补全 + 保存'))
  ok('与世界设定同形：两者页头都用 px-3.5 h-9 rounded-lg text-13 的按钮规格',
    ps.includes('px-3.5 h-9 rounded-lg text-13') && ws.includes('px-3.5 h-9 rounded-lg text-13'))
  ok('未选条目时保存 / AI 补全一并禁用', ps.includes('disabled={!selSub || !dirty || saving}') && ps.includes('disabled={!aiReady || !selSub}'))

  // ── ④ 弹窗主语解析兼容「AI 新增」前缀（否则对话引导会拿整串标题当主语） ──
  const aitf = read('src/components/AITemplateFill.tsx')
  ok('🔴 subjectLabel 正则同时剥「AI 补全」与「AI 新增」前缀',
    aitf.includes('/^AI (?:补全|新增)(?:本行空白)?\\s*·\\s*/'))

  // ── ⑤ 表单页（FormSheet）本就是真补全，命名与行为都无需动 ──
  const fs2 = read('src/components/FormSheet.tsx')
  ok('作品信息（表单页）保持「AI 补全」且传 existing={data}', fs2.includes('AI 补全 · ${tab.name}') && fs2.includes('existing={data}'))

  // ── ⑥ 口径文案同步（未接入模型的禁用清单 / 数据源标签 / 整理弹窗辨义） ──
  const scope = read('src/lib/aiScope.ts')
  ok('未接入模型清单同步为「AI 新增」与「AI 补全」', scope.includes('「AI 新增」与「AI 补全」'))
  const ds = read('src/lib/aiDataSources.ts')
  ok('数据源标签覆盖面同步（含表格行）', ds.includes('AI 补全 / AI 新增'))
  const org = read('src/components/AIOrganize.tsx')
  ok('整理弹窗辨义改为「AI 新增」（新增=凭空造，整理=抽已写）', org.includes('与「AI 新增」的本质区别'))

  console.log(`\n  ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
