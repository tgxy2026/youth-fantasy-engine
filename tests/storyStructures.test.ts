/**
 * 2.5.0 · A1 结构模板库 —— 单测
 *
 * 测的是模板数据本身的**完整性与几何正确性**（这决定了大纲提示词与配比分析的可信度）：
 *   ① 占比区间：首拍从 0 起、末拍到 100 收、相邻不重叠不倒挂、from < to
 *   ② 文案完备：name / brief / ask 非空，占比文案格式合法
 *   ③ id 封闭与容错：getStoryTemplate 对脏值（老数据 / 手改）必须返回 null，不得抛
 *   ④ formatStructureHint：注入文本包含全部节拍名与占比，体量可控（不撑爆提示词预算）
 */
import { STORY_TEMPLATES, getStoryTemplate, formatStructureHint } from '../src/lib/outline/storyStructures'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ storyStructures')

// ---------- 1) 模板集形态：非空、id 唯一、字段完备 ----------
{
  ok('至少 4 套模板', STORY_TEMPLATES.length >= 4, `got ${STORY_TEMPLATES.length}`)
  const ids = STORY_TEMPLATES.map(t => t.id)
  ok('模板 id 唯一', new Set(ids).size === ids.length)
  for (const t of STORY_TEMPLATES) {
    ok(`[${t.id}] 名称与适用说明非空`, t.name.trim().length > 0 && t.genre.trim().length > 0)
    ok(`[${t.id}] 节拍数 ≥ 2`, t.beats.length >= 2, `${t.beats.length} 拍`)
  }
}

// ---------- 2) 占比几何：这是配比分析与提示词折算的地基，错一格全盘误导 ----------
for (const t of STORY_TEMPLATES) {
  const beats = t.beats
  ok(`[${t.id}] 首拍从 0 起`, beats[0].from === 0)
  ok(`[${t.id}] 末拍到 100 收`, beats[beats.length - 1].to === 100)
  ok(`[${t.id}] 占比连续单调（相邻不重叠不倒挂）`,
    beats.every((b, i) => i === 0 || (beats[i - 1].to <= b.from && b.from < b.to)))
  ok(`[${t.id}] 全部占比在 0~100 内`, beats.every(b => b.from >= 0 && b.to <= 100))
}

// ---------- 3) 文案完备：brief / ask 自撰且非空（版权红线靠人守，完备性靠闸守） ----------
for (const t of STORY_TEMPLATES) {
  ok(`[${t.id}] 每拍 brief 非空`, t.beats.every(b => b.brief.trim().length >= 6))
  ok(`[${t.id}] 每拍 ask 非空`, t.beats.every(b => b.ask.trim().length >= 6))
}

// ---------- 4) getStoryTemplate：合法取到、脏值一律 null（不得抛） ----------
{
  const first = STORY_TEMPLATES[0]
  ok('合法 id 取到模板', getStoryTemplate(first.id)?.id === first.id)
  ok('undefined → null（未选择的正常态）', getStoryTemplate(undefined) === null)
  ok('空串 → null', getStoryTemplate('') === null)
  ok('数字 → null（settingsKV 脏值不抛）', getStoryTemplate(123 as unknown) === null)
  ok('不存在的串 → null', getStoryTemplate('deleted-template') === null)
}

// ---------- 5) formatStructureHint：注入文本的形态与体量 ----------
for (const t of STORY_TEMPLATES) {
  const hint = formatStructureHint(t)
  ok(`[${t.id}] hint 含模板名`, hint.includes(t.name))
  ok(`[${t.id}] hint 含「全书结构参考」标记`, hint.includes('全书结构参考'))
  ok(`[${t.id}] hint 含全部节拍名`, t.beats.every(b => hint.includes(b.name)))
  ok(`[${t.id}] hint 含占比区间文案`, hint.includes(`${t.beats[0].from}%-${t.beats[0].to}%`))
  // 🔴 体量闸：hint 直接进大纲 system 提示词，超过 900 字就会挤压体量预算
  // （15 拍最长，实测约 700 字；超了说明定义写得太啰嗦，先瘦文案再放行）
  ok(`[${t.id}] hint ≤ 900 字（不撑爆提示词预算）`, hint.length <= 900, `${hint.length} 字`)
}

console.log(`\n  结果：${pass} pass / ${fail} fail`)
if (fail > 0) process.exit(1)
