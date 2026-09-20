// ============ 深度校对拆两块（文字层 / 逻辑层）============
//
// 2026-09-20 老大要求：原先一个「AI 深度校对」混查 5 类（错别字 / 语病 / 逻辑 / 设定矛盾 / 标点），
// 拆成两块独立跑。这个用例盯四件事：
//   ① 拆干净了 —— 老入口 `aiProofread` 必须消失（留着就一定有人继续调，"拆开"等于没拆）；
//   ② 🔴 **文字层不读设定资料** —— 这是"效率更高"的实质，只加参数不用等于白拆；
//   ③ 提示词加严点到位（原判据「宁可少报」正是检出量低于同类工具的原因）；
//   ④ 两块在界面上真的分开呈现，且「替换此条」会重锚定**两块**。
import fs from 'node:fs'
import path from 'node:path'
import * as tasks from '../src/lib/aiTasks'
import { PROOFREAD_PROMPTS } from '../src/lib/aiTasks/proofread'
import { AI_DATA_SOURCES } from '../src/lib/aiDataSources'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 拆干净 ----------
{
  ok('导出了 aiProofreadText（文字层）', typeof tasks.aiProofreadText === 'function')
  ok('导出了 aiProofreadLogic（逻辑层）', typeof tasks.aiProofreadLogic === 'function')
  ok('🔴 混查五类的 aiProofread 已从门面移除（留着就会有人继续调）',
    !('aiProofread' in tasks))

  const orderSrc = read('src/lib/aiTasks.ts')
  ok('🔴 两条新提示词都登记进 PROMPT_ORDER（漏登记只有 warn，界面上看不出来）',
    /'proofread-text',/.test(orderSrc) && /'proofread-logic',/.test(orderSrc))
  ok('🔴 PROMPT_ORDER 里不再留旧的 proofread（否则设置页会多出一条谁也不认识的）',
    !/^\s*'proofread',\s*$/m.test(orderSrc))
}

// ---------- ② 两条提示词 ----------
{
  const ids = PROOFREAD_PROMPTS.map(p => p.meta.id)
  ok('正好两条提示词', PROOFREAD_PROMPTS.length === 2, ids.join(','))
  ok('id 就是注册表里那两个', JSON.stringify(ids) === JSON.stringify(['proofread-text', 'proofread-logic']), ids.join(','))
  ok('两条都挂在「编辑与审校」组（与改造前同组，作者找得到）',
    PROOFREAD_PROMPTS.every(p => p.meta.group === '编辑与审校'))
  ok('每条都能读能写（read/write 成对，否则设置页改不了）',
    PROOFREAD_PROMPTS.every(p => typeof p.read === 'function' && typeof p.write === 'function'))
  ok('每条都有中文名与用途说明（设置页要显示）',
    PROOFREAD_PROMPTS.every(p => !!p.meta.name.trim() && !!p.meta.note?.trim()))
}

// ---------- ③ 🔴 文字层不读设定资料（"效率更高"的实质） ----------
{
  const src = read('src/lib/aiTasks/proofread.ts')
  ok('🔴 文字层 withContext=false：不注入设定资料，出结果更快',
    /runProofread\(text, PROOFREAD_TEXT_SYS, opts, false, 2200\)/.test(src))
  ok('🔴 逻辑层 withContext=true：判设定冲突必须有依据',
    /runProofread\(text, PROOFREAD_LOGIC_SYS, opts, true, 3500\)/.test(src))
  ok('🔴 withContext 真的参与组装（不是收了个参数没人用）',
    // 允许 withContext 与 ? 之间夹注释行（源码里正是这么写的）
    /withContext\s*(?:\/\/[^\n]*\n\s*)*\?/.test(src) && /【设定资料】/.test(src))
  ok('逻辑层块更大（判前后矛盾需要更宽的视野）', /, true, 3500\)/.test(src))
}

// ---------- ④ 提示词加严 ----------
{
  const textSys = PROOFREAD_PROMPTS.find(p => p.meta.id === 'proofread-text')!.read()
  const logicSys = PROOFREAD_PROMPTS.find(p => p.meta.id === 'proofread-logic')!.read()

  ok('🔴 文字层必须逐句读完（旧提示词只有"逐句检查"一句，模型实际会跳读）',
    /必须逐句读完/.test(textSys) && /不许跳读/.test(textSys))
  ok('🔴 判据从"宁可少报"改成"先找出来、由作者判断"（这正是检出量低的原因）',
    /只要读起来确实有错或高度可疑就报/.test(textSys) && !/宁可少报/.test(textSys))
  ok('给出了同音字易漏清单（的｜地｜得 一类）', /的｜地｜得/.test(textSys))
  ok('给出了形近字易漏清单', /戊｜戌｜戍/.test(textSys))
  ok('覆盖多字 / 漏字 / 词序颠倒', /多字 \/ 漏字 \/ 词序颠倒/.test(textSys))
  ok('🔴 放宽判据的同时把"不许编造"写硬（否则会变成瞎报）',
    /绝不许编造/.test(textSys))
  ok('🔴 文字层明确"本次没有设定资料可比"，不许凭空猜专名写错',
    /没有给你设定资料/.test(textSys))
  ok('🔴 提示词里不出现 markdown 星号（模型会模仿，正文就会混进 **）',
    !textSys.includes('**') && !logicSys.includes('**'))
  ok('逻辑层声明不管错别字 / 语病 / 标点（否则两块结果重叠，作者看到同一处被报两遍）',
    /你不处理错别字、语病、标点/.test(logicSys))
  ok('逻辑层要求 why 写清"与设定资料的哪一条冲突"', /与设定资料的哪一条冲突/.test(logicSys))
  ok('🔴 两层的 quote 逐字约束都保留（前端靠 indexOf 定位，改了这条就点不动）',
    /逐字照抄原文/.test(textSys) && /逐字照抄原文/.test(logicSys))
}

// ---------- ⑤ 界面：两处入口都拆开 ----------
{
  const ed = read('src/components/EditorModals.tsx')
  const jw = read('src/components/JieWenJi.tsx')

  ok('编辑器校对弹窗两个按钮分开跑',
    /SCOPE_ORDER\.map/.test(ed) && /查错别字与语病/.test(ed) && /查逻辑与设定矛盾/.test(ed))
  ok('编辑器两块结果各存一份（互不覆盖、各有进度）', /Record<ProofScope, ScopeState>/.test(ed))
  ok('颉文姬诊室同样两块', /Record<ProofScope, ProofState>/.test(jw) && /PROOF_ORDER\.map/.test(jw))
  ok('🔴 「替换此条」重锚定**两块**（只重锚定自己那块，切过去再点就是定位失败）',
    /for \(const k of SCOPE_ORDER\)/.test(ed) && /for \(const k of PROOF_ORDER\)/.test(jw))
  ok('两块都挂了「本次会读哪些数据」说明（文案闸要求界面真的引用）',
    /feature="proofread"/.test(ed) && /feature="proofread-logic"/.test(ed))
  ok('编辑器里文字层不请求设定资料、逻辑层才请求（与任务层一致）',
    /if \(scope === 'logic'\)/.test(ed) && /buildProjectContext/.test(ed))
  ok('颉文姬里同样是「逻辑层才读设定」', /if \(scope === 'logic'\)/.test(jw))
  ok('🔴 颉文姬标注了"同一时刻只跑一块"（本面板共用一个取消器，并发会互相顶掉）',
    /同一时刻只允许跑一块/.test(jw) && /propsRunning/.test(jw))
}

// ---------- ⑥ 数据源声明与额度说明 ----------
{
  const pr = AI_DATA_SOURCES['proofread']
  ok('🔴 文字层的数据源说明写明"不读设定资料"（口径必须与代码一致）',
    (pr?.excludes ?? []).some(x => x.includes('文字层刻意不读设定')))
  ok('文字层不再把设定资料列进 sources',
    !(pr?.sources ?? []).some(s => s.group.includes('设定资料')))
  ok('新增了 proofread-logic 条目', !!AI_DATA_SOURCES['proofread-logic'])
  ok('逻辑层条目写明了读设定资料与块更大',
    /项目设定资料/.test(JSON.stringify(AI_DATA_SOURCES['proofread-logic'].sources)))

  ok('数据额度说明跟着改（文字层不读设定，不占额度）',
    /文字层不读设定/.test(read('src/lib/aiWriterBudget.ts')))
}

console.log(`\n—— proofreadSplit 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
