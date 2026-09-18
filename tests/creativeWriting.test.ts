// ============ 「创意写作」编排层的回归用例 ============
//
// 这一层最容易出的两类错，都不会让 tsc 或界面报错：
//   ① **上限失效** —— prompt 里写了"不超过 N 个角色"，但生成型入口若不在代码里再兜一道，
//      模型偶尔会一口气给 20 个，作者光删就删到手软；
//   ② **落库不幂等** —— 用户重跑一次流程，卷/大纲/细纲被重复创建，项目里多出一堆重名条目。
// 另外锁住"细纲能被读回并注入连写"这条链路（它是"按大纲写"的唯一依据）。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { DEFAULT_BIBLE_COUNTS, collectBibleEntities, type BibleCounts } from '../src/lib/aiTasks'
import { commitOutline, loadChapterOutlines } from '../src/lib/aiWorkflow'
import { CREATIVE_SEED_SPEC, seedFromFilled } from '../src/lib/creativeSeed'
import { resolveSlot } from '../src/lib/flow/fieldMap'
import type { OutlineResult } from '../src/lib/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① Bible 摊平：上限裁剪 + 字段映射 + 生成型不留 evidence ----------
{
  const counts: BibleCounts = { ...DEFAULT_BIBLE_COUNTS, main: 1, secondary: 1, npc: 1, faction: 1, location: 1, term: 1, item: 1 }
  const ents = collectBibleEntities({
    characters: [
      { name: '陈渊', tier: '主要', desc: '主角', identity: '杂役弟子', traits: '坚韧', realm: '淬体一重', faction: '青岚宗', special: '吞噬进化' },
      { name: '萧景行', tier: '次要', desc: '宿敌' },
      { name: '王铁柱', tier: 'NPC', desc: '损友' },
      { name: '多出来的', tier: 'NPC', desc: '应被裁掉' },
    ],
    factions: [{ name: '青岚宗', desc: '小宗', category: '宗门', leader: '玄真子' }, { name: '溢出势力', desc: 'x' }],
    locations: [{ name: '云州', desc: '边陲', category: '区域', parent: '东洲' }],
    terms: [{ name: '玄脉', desc: '修行体系', category: '境界' }],
    items: [{ name: '玄铁令', desc: '信物', category: '法宝', grade: '灵器' }],
  }, counts)

  ok('🔴 人物按上限裁剪（main+secondary+npc = 3）', ents.filter(e => e.type === '人物').length === 3,
    String(ents.filter(e => e.type === '人物').length))
  ok('🔴 势力按上限裁剪（1）', ents.filter(e => e.type === '势力').length === 1)
  ok('被裁掉的名字确实不在结果里', !ents.some(e => e.name === '多出来的' || e.name === '溢出势力'))
  ok('空的 name 被丢弃', collectBibleEntities({ locations: [{ name: '', desc: 'x' }] }, counts).length === 0)

  const chen = ents.find(e => e.name === '陈渊')
  ok('人物 tier 透传', chen?.tier === '主要', String(chen?.tier))
  ok('人物额外字段进了 fields（identity/traits/realm/faction/special）',
    chen?.fields?.identity === '杂役弟子' && chen?.fields?.special === '吞噬进化', JSON.stringify(chen?.fields))
  ok('非人物的 tier 不被硬塞', !ents.find(e => e.name === '青岚宗')?.tier)
  ok('🔴 生成型实体不带 evidence（引用核对只对拆书有意义）', ents.every(e => e.evidence === ''))
  ok('势力带 category/leader 字段',
    ents.find(e => e.name === '青岚宗')?.fields?.leader === '玄真子',
    JSON.stringify(ents.find(e => e.name === '青岚宗')?.fields))
  ok('缺失字段不产生空串键（不留噪声）',
    !Object.keys(chen?.fields ?? {}).some(k => !(chen?.fields ?? {})[k]))
}

// ---------- ② 大纲落库：建卷 + 两类卡片 ----------
__resetMockStores()
db.setCurrentProject('cw-test')

const OUTLINE: OutlineResult = {
  volumes: [{
    title: '风起云州', positioning: '废脉少年觉醒', stage: '淬体→聚灵', scope: '云州·青岚宗',
    opening: '寄居杂役院', climax1: '雨夜反杀', turn: '宿敌露真面目', climax2: '外门大比夺魁',
    ending: '获得秘境名额', events: '测灵→觉醒→受辱→反杀→大比→揭密', subplots: '兄妹温情线',
  }],
  chapters: [
    { no: 1, title: '废脉', event: '测灵大典判定废脉，当夜神体觉醒', fn: '开局冲突', cast: '陈渊、陈瑶', hook: '识海传来苍老声音', scenes: ['演武场测灵', '杂役院夜话', '深夜觉醒'] },
    { no: 2, title: '塔灵', event: '青铜小塔首次出声', fn: '金手指引入', cast: '陈渊', hook: '塔灵说了句没头没尾的话', scenes: ['识海对话'] },
  ],
}

{
  const r = await commitOutline(OUTLINE)
  ok('建了 1 卷', r.volumesCreated === 1, String(r.volumesCreated))
  ok('建了 1 份分卷大纲卡', r.volumeCardsCreated === 1, String(r.volumeCardsCreated))
  ok('建了 2 份章节细纲卡', r.chapterCardsCreated === 2, String(r.chapterCardsCreated))
  ok('无失败项', r.failed.length === 0, r.failed.join(','))

  const vols = await db.getAllVolumes()
  ok('卷已落库且标题正确', vols.length === 1 && vols[0].title === '风起云州', vols.map(v => v.title).join(','))
  ok('卷描述用了「本卷一句话定位」', vols[0].description === '废脉少年觉醒', vols[0].description)

  const volCards = await db.getCardRecords('volume-outline')
  ok('分卷大纲卡落库', volCards.length === 1)
  const volNameKey = resolveSlot('volume-outline', '卷名')
  const volClimaxKey = resolveSlot('volume-outline', '卷末高潮')
  ok('🔴 大纲字段落进目标表真实键（卷名）', !!volNameKey && volCards[0].data[volNameKey] === '风起云州',
    JSON.stringify(Object.keys(volCards[0].data)))
  ok('卷末高潮写进正确列', !!volClimaxKey && volCards[0].data[volClimaxKey] === '外门大比夺魁', String(volCards[0].data[volClimaxKey ?? '']))

  const chCards = await db.getCardRecords('chapter-outline')
  ok('章节细纲卡落库 2 份', chCards.length === 2, String(chCards.length))
  ok('细纲卡名形如「第N章 标题」', chCards.every(c => /^第\d+章 /.test(c.name)), chCards.map(c => c.name).join(','))
  const chNoKey = resolveSlot('chapter-outline', '章节号/标题')
  ok('细纲里的章号字段带前缀（与卡名一致）', !!chNoKey && chCards[0].data[chNoKey] === '第1章 废脉', String(chCards[0].data[chNoKey ?? '']))
}

// ---------- ③ 幂等：重跑不重复建 ----------
{
  const r2 = await commitOutline(OUTLINE)
  ok('🔴 重跑：同名卷不重复建', r2.volumesCreated === 0, String(r2.volumesCreated))
  ok('🔴 重跑：同名分卷大纲卡不重复建', r2.volumeCardsCreated === 0, String(r2.volumeCardsCreated))
  ok('🔴 重跑：同名章节细纲卡不重复建', r2.chapterCardsCreated === 0, String(r2.chapterCardsCreated))
  ok('卷总数仍是 1', (await db.getAllVolumes()).length === 1)
  ok('细纲卡总数仍是 2', (await db.getCardRecords('chapter-outline')).length === 2)
}

// ---------- ④ 细纲能被读回（「按大纲写」的唯一依据） ----------
{
  const m = await loadChapterOutlines()
  ok('读回 2 章细纲', m.size === 2, String(m.size))
  ok('第 1 章细纲含事件', (m.get(1) ?? '').includes('测灵大典'), String(m.get(1)))
  ok('第 1 章细纲含场景', (m.get(1) ?? '').includes('场景1'), String(m.get(1)))
  ok('第 1 章细纲含章末钩子', (m.get(1) ?? '').includes('苍老声音'), String(m.get(1)))
  ok('第 2 章细纲独立', (m.get(2) ?? '').includes('青铜小塔'), String(m.get(2)))
  ok('没有第 3 章细纲（不凭空造）', m.get(3) === undefined)
}

// ---------- ⑤ 空大纲不炸 ----------
{
  const r = await commitOutline({ volumes: [], chapters: [] })
  ok('空大纲 → 全部计数为 0 且不抛错',
    r.volumesCreated === 0 && r.volumeCardsCreated === 0 && r.chapterCardsCreated === 0)
}

// ---------- ⑥ 「对话引导」的纲与"拼回想法"的一致性 ----------
// 这层很容易腐烂：往 spec 里加了一栏，却忘了给它写话题 → 那一栏**永远问不到**，
// 界面进度还会显示"共 N 栏"，作者以为 AI 会问。所以两头都要对一遍。
{
  const spec = CREATIVE_SEED_SPEC
  ok('想法引导：每个话题的字段都在白名单里（否则模型写了也会被丢掉）',
    spec.topics.every(t => t.fields.every(f => spec.allowedKeys.includes(f))),
    spec.topics.flatMap(t => t.fields).filter(f => !spec.allowedKeys.includes(f)).join(','))
  ok('🔴 想法引导：白名单被话题全覆盖（有栏位无话题 = 永远问不到）',
    spec.allowedKeys.every(k => spec.topics.some(t => t.fields.includes(k))),
    spec.allowedKeys.filter(k => !spec.topics.some(t => t.fields.includes(k))).join(','))
  ok('想法引导：每栏都有中文名（右侧"已收集"面板按它摊平）',
    spec.allowedKeys.every(k => !!spec.labels?.[k]),
    spec.allowedKeys.filter(k => !spec.labels?.[k]).join(','))
  ok('想法引导：话题顺序＝先定调、再定人、后定壳',
    spec.topics.map(t => t.key).join(',') === 'genre,hero,conflict,shell',
    spec.topics.map(t => t.key).join(','))

  const text = seedFromFilled({ genre: '玄幻', protagonist: '杂役少年', style: '冷厉克制' })
  ok('拼回想法：带中文标签（作者能逐行核对是不是自己说的）',
    text.includes('【题材类型】玄幻') && text.includes('【主角是谁】杂役少年'), text)
  ok('🔴 拼回想法：空栏不出现（不留"（未填）"污染提示词）', !text.includes('核心冲突'), text)
  ok('拼回想法：全空 → 空串（调用方据此不覆盖输入框）', seedFromFilled({}) === '')
}

console.log(`\n—— creativeWriting 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
