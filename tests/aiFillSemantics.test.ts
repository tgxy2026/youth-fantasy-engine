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
import { readAiModule } from './sourceScan'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

function main() {
  // ── ① 角色管理组（CharacterSheet）：AI 新增（建卡）+ AI 补全（补当前卡）两个入口并存 ──
  const cs = read('src/components/world/CharacterSheet.tsx')
  ok('角色卡右上角同时有「AI 新增」与「AI 补全」', cs.includes('AI 新增') && cs.includes('AI 补全'))
  ok('AI 新增：点开的是新建弹窗 setShowFill(true)', cs.includes('onClick={() => setShowFill(true)}'))
  ok('AI 新增：弹窗标题为「AI 新增 · 页签名」', cs.includes('AI 新增 · ${tab.name}'))
  ok('🔴 AI 补全：新增独立状态 setShowFillExisting(true)', cs.includes('const [showFillExisting, setShowFillExisting] = useState(false)') && cs.includes('onClick={() => setShowFillExisting(true)}'))
  // WT2：existing 只带「允许 AI 参考」的已填值（禁读字段的值不进模型材料）
  ok('🔴 AI 补全：传进来的已填值只含可参考字段（已填字段锁定、只补空白）',
    cs.includes('existing={cardAiExisting}') && /cardAiReadKeys\.has\(k\)/.test(cs) && cs.includes('out[k] = v'))
  ok('🔴 AI 补全：弹窗标题带当前卡名', cs.includes('AI 补全 · ${draft.name}'))
  ok('🔴 AI 补全：未选卡时禁用（!aiReady || !draft）', cs.includes('disabled={!aiReady || !draft}'))
  ok('🔴 AI 补全采用时只写非空字段（已填的保留，与 FormSheet 同口径）',
    /const accepted = acceptAiValues\(values\)/.test(cs)
    && /if \(v && v\.trim\(\)\) next\.data\[k\] = v/.test(cs)
    && /if \(cur\) continue/.test(cs))
  ok('AI 新增仍走 handleFill（建卡落库），未被改动', cs.includes('onSubmit={handleFill}'))
  // WT2：卡片也要按有效模板分读 / 写两个用途，且旧结果不得写进新结构
  ok('🔴 采用模板后卡片 AI 清单分别按 aiWrite / aiRead 解析',
    cs.includes("purpose: 'aiWrite'") && cs.includes("purpose: 'aiRead'"))
  ok('🔴 AI 结果只保留当前可写键（防幽灵字段）', cs.includes('pickValuesOfKeys(values, cardAiFields'))
  ok('🔴 模板在生成期间改过 ⇒ 整批作废', cs.includes('acceptAiValues(values)') && cs.includes('semanticDigest !== aiBasisRef.current'))

  // ── ② 世界构建组 + 全项目表格（TableSheet）：右上角「AI 新增」，行首才是「AI 补全本行空白」 ──
  const ts = read('src/components/sheets/TableSheet.tsx')
  ok('🔴 表格右上角：organize 显「AI 整理」、fill 显「AI 新增」',
    ts.includes("{aiCap === 'organize' ? 'AI 整理' : 'AI 新增'}"))
  ok('🔴 右上角新建行弹窗标题改为「AI 新增 · 表名」', ts.includes('AI 新增 · ${tab.name}'))
  ok('🔴 行首补空白弹窗标题保持「AI 补全本行空白」（这是真补全）',
    ts.includes('AI 补全本行空白 · ${tab.name}') && ts.includes('existing={fillRow.data}'))
  ok('表格问号说明同步为「AI 整理」或「AI 新增」', ts.includes('「AI 整理」或「AI 新增」'))
  ok('🔴「AI 整理」按钮与链路原样未动', ts.includes("setShowOrganize(true)") && ts.includes('<AIOrganize'))

  const row = read('src/components/sheets/TableSheetRow.tsx')
  ok('🔴 行首行内按钮文案未受影响（AI 补全本行空白）', row.includes('AI 补全本行空白'))
  const rel = read('src/components/sheets/TableRelationGroups.tsx')
  ok('关系分组里的行内补全提示也保持「AI 补全本行空白」', rel.includes('AI 补全本行空白'))

  // ── ③ 开书定位组（ParallelSetSheet）：保存 + AI 补全挪到页头，与 WorldSetSheet 同形 ──
  const ps = read('src/components/sheets/ParallelSetSheet.tsx')
  const ws = read('src/components/sheets/WorldSetSheet.tsx')
  ok('🔴 制度四页签页头右端有按钮组（ml-auto flex items-center gap-2）', ps.includes('ml-auto flex items-center gap-2'))
  ok('🔴 页头出现 AI 补全按钮', /<Sparkles size=\{12\} \/> AI 补全/.test(ps))
  ok('🔴 页头出现保存按钮（variant="toggle" + flush）', ps.includes('variant="toggle" selected={dirty}') && ps.includes('onClick={() => void flush()}'))
  ok('🔴 右栏底部那排按钮已撤（不再有两处同功能）', !ps.includes('底部：AI 补全 + 保存'))
  ok('与世界设定同形：两者页头都用 px-3.5 h-9 rounded-lg text-13 的按钮规格',
    ps.includes('px-3.5 h-9 rounded-lg text-13') && ws.includes('px-3.5 h-9 rounded-lg text-13'))
  ok('未选条目时保存 / AI 补全一并禁用', ps.includes('disabled={!selSub || !dirty || saving}') && ps.includes('disabled={!aiReady || !selSub}'))

  // ── ④ 弹窗主语解析兼容「AI 新增」前缀（否则对话引导会拿整串标题当主语） ──
  const aitf = read('src/components/ai/AITemplateFill.tsx')
  ok('🔴 subjectLabel 正则同时剥「AI 补全」与「AI 新增」前缀',
    aitf.includes('/^AI (?:补全|新增)(?:本行空白)?\\s*·\\s*/'))

  // ── ⑤ 表单页（FormSheet）本就是真补全，命名与行为都无需动 ──
  const fs2 = read('src/components/sheets/FormSheet.tsx')
  ok('作品信息（表单页）保持「AI 补全」且传 existing={data}', fs2.includes('AI 补全 · ${tab.name}') && fs2.includes('existing={data}'))

  // ── ⑥ 口径文案同步（未接入模型的禁用清单 / 数据源标签 / 整理弹窗辨义） ──
  const scope = read('src/lib/ai/aiScope.ts')
  ok('未接入模型清单同步为「AI 新增」与「AI 补全」', scope.includes('「AI 新增」与「AI 补全」'))
  const ds = read('src/lib/ai/aiDataSources.ts')
  ok('数据源标签覆盖面同步（含表格行）', ds.includes('AI 补全 / AI 新增'))
  const org = read('src/components/ai/AIOrganize.tsx')
  ok('整理弹窗辨义改为「AI 新增」（新增=凭空造，整理=抽已写）', org.includes('与「AI 新增」的本质区别'))

  // ── ⑦ 大纲规划组（2026-10-03 老大解禁）：全书总纲 / 分卷大纲 / 章节细纲 也接 AI 新增 + AI 补全 ──
  const scope2 = read('src/lib/ai/aiScope.ts')
  ok('🔴 aiScope 特批了三个大纲页签（只放 id、不按 group 放行）',
    /const AI_OUTLINE_TAB_IDS = new Set\(\['master', 'volume-outline', 'chapter-outline'\]\)/.test(scope2))
  // 先要求分支**存在**（indexOf ≥ 0）：否则把分支删掉时 indexOf 返回 -1，而 -1 < 正数 恒真 ⇒ 护栏假绿。
  const iOutline = scope2.indexOf('AI_OUTLINE_TAB_IDS.has(tab.id)')
  ok('🔴 放行分支排在「整组不接 AI」之前（排在后面等于没放）',
    iOutline >= 0 && iOutline < scope2.indexOf('NO_AI_GROUPS.includes(tab.group)'))
  ok('大纲规划仍留在 NO_AI_GROUPS 里（兜住该组其余页签）',
    /const NO_AI_GROUPS = \['大纲规划', '运营维护'\]/.test(scope2))

  const os = read('src/components/outline/OutlineSheet.tsx')
  ok('🔴 分卷大纲 / 章节细纲：两个入口并存（AI 新增 + AI 补全）',
    os.includes('AI 新增') && os.includes('AI 补全'))
  ok('🔴 AI 新增：独立状态 + 弹窗标题「AI 新增 · 页签名」',
    os.includes('onClick={() => setShowFillNew(true)}') && os.includes('AI 新增 · ${tab.name}'))
  ok('🔴 AI 补全：独立状态 setShowFillExisting(true) + 传 existing={draft.data}',
    os.includes('onClick={() => setShowFillExisting(true)}') && os.includes('existing={draft.data}'))
  ok('🔴 AI 补全：弹窗标题带当前条目名 + 未选条目时禁用',
    os.includes('AI 补全 · ${draft.name}') && os.includes('disabled={!aiReady || !draft}'))
  ok('🔴 AI 补全采用时只写非空字段（已填的保留，与 FormSheet / CharacterSheet 同口径）',
    /for \(const \[k, v\] of Object\.entries\(values\)\) if \(v && v\.trim\(\)\) next\.data\[k\] = v/.test(os))
  ok('🔴 AI 新增落在目录最上方（order = 最小 order − 1，与本页「新建」一致）',
    os.includes('Math.min(...records.map(r => r.order)) - 1'))
  ok('🔴 两条弹窗各带自己的补全语境（分卷 / 章节），且都透传给 AITemplateFill',
    os.includes("isVolume ? 'outline-volume' : 'outline-chapter'") && (os.match(/context=\{fillContext\}/g) ?? []).length === 2)

  const fs3 = read('src/components/sheets/FormSheet.tsx')
  ok('🔴 全书总纲：表单页也给「AI 新增」（只挂 master 一个 id）',
    fs3.includes("const isOutlineMaster = tab.id === 'master'") && fs3.includes('AI 新增'))
  ok('🔴 全书总纲的 AI 新增：已填非空时先确认（起草全份不可逆）',
    fs3.includes('onClick={() => void openFillNew()}') && /if \(filled > 0 && !await confirmDialog/.test(fs3))
  ok('🔴 「起草全份」与「补全」的分界：全文只允许一条弹窗传 existing={data}',
    (fs3.match(/existing=\{data\}/g) ?? []).length === 1)
  ok('🔴 其余表单页不受影响：作品信息仍保持「AI 补全」且传 existing={data}',
    fs3.includes('AI 补全 · ${tab.name}') && fs3.includes('existing={data}'))

  // 🔴 读**整个 ai 模块**（门面 + aiCore/*）：三条大纲提示词与 FILL_CONTEXT_SYS 随拆分
  //    搬进了 aiCore/prompts.ts / aiCore/template.ts，只读门面会静默失明（2026-10-04 踩过）。
  const aiSrc = readAiModule()
  ok('🔴 三条大纲提示词各自就地声明（可单独在设置页微调）',
    ['P_fill_outline_master', 'P_fill_outline_volume', 'P_fill_outline_chapter']
      .every(v => new RegExp(`let ${v} = `).test(aiSrc)))
  ok('🔴 三条都登记进「模型设置 → AI 提示词」',
    ['fill-outline-master', 'fill-outline-volume', 'fill-outline-chapter']
      .every(id => new RegExp(`registerPrompt\\(\\{ id: '${id}'`).test(aiSrc)))
  ok('🔴 aiCompleteTemplate 按语境取提示词（不再恒取通用那条）',
    /const sys = FILL_CONTEXT_SYS\[opts\.context \?\? 'template'\]\(\)/.test(aiSrc))
  const outlineBodies = ['P_fill_outline_master', 'P_fill_outline_volume', 'P_fill_outline_chapter']
    .map(v => (aiSrc.match(new RegExp(`let ${v} = \`([\\s\\S]*?)\``)) ?? [])[1] ?? '')
  ok('🔴 三条正文都写足了（各 > 200 字）且不含 markdown 星号（星号会污染正文，项目红线）',
    outlineBodies.every(b => b.length > 200 && !b.includes('**')))

  console.log(`\n  ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
