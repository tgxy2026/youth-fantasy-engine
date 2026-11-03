// ============ AI 伴写 · 文风补充多维多选（2.6.4）============
//
// 锁四件界面上不太好测、但错了直接伤到生成质量的事：
//   ① 维度 id 唯一、每项都带「怎么算做到」的引导语 —— 只给标签名模型会自由发挥成套话；
//   ② `buildStyleNote` 的注入形状：空输入返回空串（整层不注入）、作者原话**排最后**（末段权重最高）；
//   ③ 互斥判定只提示不删改 —— 冲突的两项都要如实交给模型；
//   ④ 稀释阈值：>3 项要给提示（伴写一次只续一两句话，五个侧重等于没选）。
import {
  STYLE_GROUPS, STYLE_DIM_BY_ID, STYLE_DIM_IDS, STYLE_CONFLICTS, STYLE_DILUTE_AT,
  conflictsOf, activeConflicts, isDiluted, dimLabels, buildStyleNote, loadStyleDims,
} from '../src/lib/tavern/companionStyle'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 1. 维度表完整性 ----------
{
  const dup = STYLE_DIM_IDS.filter((id, i) => STYLE_DIM_IDS.indexOf(id) !== i)
  ok('维度 id 全局唯一', dup.length === 0, dup.join(','))
  ok('三组齐备（描写 / 叙事 / 氛围）', STYLE_GROUPS.length === 3 && STYLE_GROUPS.map(g => g.id).join(',') === 'depict,narrate,tone')
  ok('共 18 项', STYLE_DIM_IDS.length === 18, String(STYLE_DIM_IDS.length))
  const noHint = STYLE_DIM_IDS.filter(id => (STYLE_DIM_BY_ID[id]?.hint ?? '').length < 12)
  ok('每项都带「怎么算做到」的引导语（≥12 字）', noHint.length === 0, noHint.join(','))
  const noLabel = STYLE_DIM_IDS.filter(id => !(STYLE_DIM_BY_ID[id]?.label ?? '').trim())
  ok('每项都有显示名', noLabel.length === 0, noLabel.join(','))
  // 需求原话：原先只有「人物描写 / 环境描写」两个固定预设，必须已拆开成独立可选项
  ok('「人物描写」与「环境描写」已拆成两个独立维度',
    STYLE_DIM_IDS.includes('character') && STYLE_DIM_IDS.includes('scene'))
}

// ---------- 2. buildStyleNote：注入形状 ----------
{
  ok('两项都空 ⇒ 空串（整层不注入，不留「（无）」占位）', buildStyleNote([], '') === '')
  ok('只给空白原话 ⇒ 仍是空串', buildStyleNote([], '   ') === '')

  const onlyDims = buildStyleNote(['character', 'scene'], '')
  ok('只勾维度：含两个维度的显示名', onlyDims.includes('人物描写') && onlyDims.includes('环境描写'))
  ok('只勾维度：带引导语而非只有标签名', onlyDims.includes(STYLE_DIM_BY_ID['character'].hint))
  ok('只勾维度：不含「作者原话」段', !onlyDims.includes('作者原话'))

  const onlyNote = buildStyleNote([], '冷硬白描，少心理活动')
  ok('只填原话：原话原样进注入文本', onlyNote.includes('冷硬白描，少心理活动'))
  ok('只填原话：不凭空加维度段', !onlyNote.includes('作者勾选了'))

  const both = buildStyleNote(['character'], '多用短对白')
  ok('两者都填：维度段在前、原话段在后',
    both.indexOf('人物描写') < both.indexOf('作者原话'), both.slice(0, 80))
  ok('两者都填：写明冲突时以原话为准', both.includes('以原话为准'))
  ok('脏 id 被过滤（不把 ' + 'nonexistent' + ' 这种原样塞进去）',
    !buildStyleNote(['nonexistent'], '原话').includes('nonexistent'))
}

// ---------- 3. 冲突：只提示、不删改 ----------
{
  ok('白描简练 ↔ 细腻铺陈 登记为互斥',
    STYLE_CONFLICTS.some(([a, b]) => (a === 'plain' && b === 'detailed') || (a === 'detailed' && b === 'plain')))
  ok('留白 ↔ 细腻铺陈 登记为互斥',
    STYLE_CONFLICTS.some(([a, b]) => (a === 'blank' && b === 'detailed') || (a === 'detailed' && b === 'blank')))
  ok('未同时勾选时不报冲突', conflictsOf(['character'], 'plain').length === 0)
  ok('同时勾选时报出对方', conflictsOf(['character', 'detailed'], 'plain').join() === 'detailed')
  ok('双向都能报出（detailed 侧也认得 plain）', conflictsOf(['plain'], 'detailed').join() === 'plain')
  ok('activeConflicts 只在真冲突时非空',
    activeConflicts(['plain', 'character']).length === 0 && activeConflicts(['plain', 'detailed']).length === 1)
  // 🔴 互斥只提示不硬拦：两项都要如实交给模型，由作者的取舍决定
  const clashNote = buildStyleNote(['plain', 'detailed'], '')
  ok('互斥项仍被如实注入（不偷偷删掉一项）',
    clashNote.includes('白描简练') && clashNote.includes('细腻铺陈'))
}

// ---------- 4. 稀释阈值 ----------
{
  ok(`阈值是 ${STYLE_DILUTE_AT}（伴写一次只续一两句话）`, STYLE_DILUTE_AT === 3)
  ok('3 项不算稀释', !isDiluted(['character', 'scene', 'dialogue']))
  ok('4 项算稀释', isDiluted(['character', 'scene', 'dialogue', 'plot']))
  ok('0 项不算稀释', !isDiluted([]))
}

// ---------- 5. 显示串与读盘容错 ----------
{
  ok('dimLabels 拼出显示名', dimLabels(['character', 'scene']) === '人物描写 / 环境描写', dimLabels(['character', 'scene']))
  ok('dimLabels 对未知 id 退化成原样（不崩）', dimLabels(['zzz']) === 'zzz')
  // node 环境没有 localStorage：读盘必须静默降级成空数组，不能把伴写整条链路炸掉
  ok('无 localStorage 时读盘降级为空数组（不抛）', Array.isArray(loadStyleDims()) && loadStyleDims().length === 0)
}

console.log(`\ncompanionStyle: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
