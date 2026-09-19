// ============ 拆书「末尾汇总全书级设定」的材料拼装与阶段位置 ============
//
// 两个容易错、且错了很难查的点：
//   ① **阶段顺序**：汇总必须排在**最后**。它吃的是前面抽出来的实体，而且口径就是
//      "整本书看完再收敛成一份档案" —— 提前跑就等于拿半本书的信息去写世界观，
//      而产出的档案看起来照样像模像样（没有任何报错）。
//   ② **材料封顶**：汇总是一次调用，把几千条实体原样塞进去必然撞窗口，
//      而撞窗口的表现是**静默截断**（模型只看到前半段却照样输出得很像样）。
import { BOOKBREAK_STAGES } from '../src/lib/bookbreak/run'
import { buildFormMaterial } from '../src/lib/bookbreak/formSummary'
import type { EntityBatch } from '../src/lib/flow/draft'
import type { ExtractedEntity } from '../src/lib/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function ent(name: string, type: ExtractedEntity['type'], over: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return { name, type, desc: `${name}的一句话描述`, evidence: '原句', ...over }
}
function batch(index: number, entities: ExtractedEntity[]): EntityBatch {
  return { source: `第${index}章`, index, entities }
}

// ---------- ① 阶段顺序：两个收尾阶段必须排最后 ----------
{
  const ids = BOOKBREAK_STAGES.map(s => s.id)
  ok('阶段表里有「汇总全书设定」这一步', ids.includes('worldview'), ids.join(','))
  ok('阶段表里有「整理关系」这一步（人物关系 / 势力关系）', ids.includes('relations'), ids.join(','))
  // 🔴 两个收尾阶段（汇总全书设定 / 整理关系）都必须在**整本抽完之后**才跑：
  //    提前跑 = 拿半本书写世界观、拿半本书定关系。
  ok('🔴 汇总全书设定排在抽取之后（提前跑 = 拿半本书写世界观）',
    ids.indexOf('extract') < ids.indexOf('worldview'), ids.join(','))
  ok('🔴 整理关系排在抽取与汇总之后（关系得整本看完再收）',
    ids.indexOf('extract') < ids.indexOf('relations') && ids.indexOf('worldview') < ids.indexOf('relations'),
    ids.join(','))
  ok('🔴 整理关系是**最后一步**（之后只剩作者审阅落库）',
    ids[ids.length - 1] === 'relations', ids.join(','))
  ok('每一步都有中文显示名（节点时间线要用）',
    BOOKBREAK_STAGES.every(s => !!s.label.trim()))
}

// ---------- ② 材料拼装：按类目聚合 ----------
{
  const m = buildFormMaterial([
    batch(1, [ent('陈渊', '人物'), ent('青岚宗', '势力'), ent('云州', '地点')]),
    batch(2, [ent('萧景行', '人物'), ent('吞天诀', '物品')]),
  ])
  ok('按实体类型分节（〖人物〗/〖势力〗…）',
    /〖人物〗/.test(m) && /〖势力〗/.test(m) && /〖地点〗/.test(m) && /〖物品〗/.test(m), m.slice(0, 120))
  ok('同类跨批次聚合到一节（陈渊与萧景行都在〖人物〗里）',
    /〖人物〗（2 条）/.test(m), m.slice(0, 200))
  ok('每条带名称与描述', m.includes('陈渊') && m.includes('陈渊的一句话描述'))
  ok('别称与全字段都带上（汇总要的就是这些）',
    buildFormMaterial([batch(1, [ent('王铁柱', '人物', {
      aliases: ['铁柱'], fields: { identity: '杂役弟子', realm: '淬体一重' },
    })])]).includes('别称：铁柱'),
    buildFormMaterial([batch(1, [ent('王铁柱', '人物', { aliases: ['铁柱'], fields: { identity: '杂役弟子' } })])]))
  ok('空实体（没有名字）不进材料',
    !buildFormMaterial([batch(1, [{ ...ent('', '人物') }])]).includes('- ：'))
}

// ---------- ③ 层层收口：每类条数 / 单条字数 / 原文开头 / 总量 ----------
{
  const many = buildFormMaterial([batch(1, Array.from({ length: 100 }, (_, i) => ent(`角色${i}`, '人物')))], '', { perType: 10 })
  ok('每类只取前 N 条（材料是代表作，不是全量清单）', /〖人物〗（10 条）/.test(many), many.match(/〖人物〗（\d+ 条）/)?.[0] ?? '')
  ok('  取的是**前** N 条（顺序稳定，不是随机抽样）', many.includes('角色0') && !many.includes('角色50'))

  const long = buildFormMaterial([batch(1, [ent('长描述角色', '人物', { desc: '字'.repeat(500) })])], '', { perEntityChars: 50 })
  const line = long.split('\n').find(l => l.startsWith('- 长描述角色')) ?? ''
  ok('单条超长被截断', line.length <= 50, String(line.length))

  const withHead = buildFormMaterial([batch(1, [ent('陈渊', '人物')])], '字'.repeat(2000), { rawHeadChars: 100 })
  ok('原文只取开头一段当题材样本', withHead.includes('字'.repeat(100)) && !withHead.includes('字'.repeat(101)), '')
  ok('  样本带标题（模型要知道这是开篇）', /〖开篇原文样本〗/.test(withHead))

  const capped = buildFormMaterial(
    [batch(1, Array.from({ length: 200 }, (_, i) => ent(`角色${i}`, '人物', { desc: '描述'.repeat(30) })))],
    '', { perType: 200, maxChars: 800 },
  )
  ok('🔴 总量封顶，且**明说已省略**（不静默截断）',
    capped.length <= 900 && /已省略/.test(capped), `${capped.length}/${/已省略/.test(capped)}`)

  ok('完全没有材料时返回空串（调用方据此跳过本阶段）',
    buildFormMaterial([], '').trim() === '', JSON.stringify(buildFormMaterial([], '')))
  ok('只有原文样本时也能出材料（不因实体为空而报错）',
    buildFormMaterial([], '开头一段').includes('开头一段'))
}

console.log(`\n—— bookbreakFormSummary 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
