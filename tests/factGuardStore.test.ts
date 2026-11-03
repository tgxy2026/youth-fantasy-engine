// 3.2.0 · WQ8 实体保留自检 · 真实存储装配 · 单测
//
// `factGuard.test.ts` 用手写的 `EntityRegistry` 钉口径；这里钉**从真实库装配**这一路：
//   ① 角色卡（char-main）的「姓名 + 别称」真的能进集合 —— 别称键是 `模块名::别称`，拼错就静默失明；
//   ② 设定表（nations / terms）的「名称 + 别称」同理；
//   ③ 🔴 **不切当前项目 ⇒ 读不到任何卡** ⇒ 集合为空 ⇒ `checked:false`。
//      这一条是反向保险：如果哪天装配被改成"读不到就当没事"，这里会抓到
//      （真丢了实体却一声不吭，比误报更糟）。
import { __resetMockStores } from './mock-memory'
import * as db from '@/lib/db'
import { setCurrentProject } from '@/lib/db/core'
import { loadRegistry } from '@/lib/settings/settingLedger'
import { checkFactRetention, collectFacts } from '@/lib/ai/factGuard'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq8-factguard-store'
const OTHER_PID = 'wq8-factguard-other'

const BODY = '王铁柱走进玄天宗大殿，玄天宗主已在等候。他运转神识，看清了局势。'
const DROPPED = '他走进宗门大殿，宗主已在等候。运转神识，看清了局势。'

/** 造一张角色卡（别称键是 `模块名::别称`，与 `readAliases` 的约定一致） */
async function seedCard() {
  await db.saveCardRecord({
    id: 'card-wang', projectId: PID, tabId: 'char-main', name: '王铁柱',
    data: { '一、基础信息::别称': '铁柱、王师傅' }, order: 0,
  } as never)
}

/** 造两行设定表（势力带别称；术语无别称） */
async function seedTables() {
  await db.saveTableRow({
    id: 'row-xuan', projectId: PID, tabId: 'nations', data: { '名称': '玄天宗', '别称': '玄天' }, order: 0,
  } as never)
  await db.saveTableRow({
    id: 'row-shen', projectId: PID, tabId: 'terms', data: { '名称': '神识' }, order: 1,
  } as never)
}

async function main() {
  await __resetMockStores()
  setCurrentProject(PID)
  await seedCard()
  await seedTables()

  const reg = await loadRegistry()
  ok('① 角色卡读进来了（不切当前项目就会静默读空）', reg.人物.length === 1, String(reg.人物.length))
  ok('① 别称读对了（键是 `模块名::别称`，拼错就静默失明）',
    reg.人物[0]?.aliases.join(',') === '铁柱,王师傅', reg.人物[0]?.aliases.join(','))
  ok('① 设定表两行都读进来了（势力 / 术语）',
    reg.势力.length === 1 && reg.术语.length === 1, `${reg.势力.length}/${reg.术语.length}`)
  ok('① 势力别称读对了（表格型键就是列名「别称」）',
    reg.势力[0]?.aliases.join(',') === '玄天', reg.势力[0]?.aliases.join(','))
  ok('① 别称列缺失 ⇒ 空数组，不是跳过整行', reg.术语[0]?.aliases.length === 0 && reg.术语.length === 1)

  {
    const facts = collectFacts(reg, BODY)
    ok('② 从真实库装配出 3 个实体（王铁柱 / 玄天宗 / 神识）',
      facts.length === 3, facts.map(f => f.name).join(','))
    ok('② 每条带来源页签（作者能跳回设定表核对）',
      facts.some(f => f.tabId === 'char-main') && facts.some(f => f.tabId === 'nations')
      && facts.some(f => f.tabId === 'terms'))
  }

  {
    const rep = await checkFactRetention(reg, BODY, BODY)
    ok('③ 一字不改 ⇒ 0 丢失且不出声', rep.lost.length === 0 && rep.summary === '')
    ok('③ 单字名「他」之类不在集合（登记表里也没有，符合预期）', rep.total === 3, String(rep.total))

    const rep2 = await checkFactRetention(reg, BODY, DROPPED)
    ok('🔴 ③ 丢了两个实体 ⇒ lost 2 且分别带来源',
      rep2.lost.length === 2 && rep2.lost.some(f => f.name === '王铁柱' && f.tabId === 'char-main')
      && rep2.lost.some(f => f.name === '玄天宗' && f.tabId === 'nations'),
      JSON.stringify(rep2.lost.map(f => `${f.name}/${f.tabId}`)))
    ok('③ 摘要点名（作者能判断该不该在）', rep2.summary.includes('王铁柱') && rep2.summary.includes('玄天宗'))
  }

  // 🔴 反向保险：换到别的项目 ⇒ 读不到 ⇒ checked:false（不能"读不到就当没事"）
  {
    setCurrentProject(OTHER_PID)
    const reg2 = await loadRegistry()
    const rep3 = await checkFactRetention(reg2, BODY, DROPPED)
    ok('🔴 ④ 读不到登记表 ⇒ checked:false 且不出声（绝不"读不到就当没事"）',
      reg2.人物.length === 0 && rep3.checked === false && rep3.summary === '',
      JSON.stringify(rep3))
    setCurrentProject(PID)
  }

  console.log(`\n———— factGuardStore：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
