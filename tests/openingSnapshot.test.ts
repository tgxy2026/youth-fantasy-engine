// ============ 3.7.0 · W6 复核补：开篇结论快照 ============
//
// 盯三件事：
//   ① 只抽「一句话定调」原话（取不到退化为首句，不编造）；
//   ② 存进项目 settingsKV，体检页可读回（否则只能永远「未跑」）；
//   ③ 读不到 / 损坏一律 null —— 界面据实写「未跑」。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  extractOpeningConclusion, readOpeningSnapshot, saveOpeningSnapshot,
  OPENING_SNAPSHOT_KEY, OPENING_SOURCE, type OpeningSnapshot,
} from '../src/lib/audit/openingSnapshot'
import { getSettingFor } from '@/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- ① 抽取 ----------
  {
    ok('独立一行的定调（下一行给结论）', extractOpeningConclusion('## 一句话定调\n需改：开局冲突不足\n\n## 黄金三章四查\n…') === '需改：开局冲突不足')
    ok('同一行写定调时去掉前缀', extractOpeningConclusion('一句话定调：能签') === '能签')
    ok('带项目符号的定调也能认', extractOpeningConclusion('- 一句话定调：有扑街风险') === '有扑街风险')
    ok('没有定调字样时退化为含结论的句子', extractOpeningConclusion('开头节奏偏慢\n需要改：前三章信息量不足') === '需要改：前三章信息量不足')
    ok('完全没有结论词时取首句（不编造结论）', extractOpeningConclusion('# 报告\n\n主角出场太晚') === '报告')
    const long = extractOpeningConclusion(`一句话定调：${'长'.repeat(200)}`)
    ok('超长结论截断并标注', long.endsWith('…') && long.length <= 121, String(long.length))
    ok('空报告返回空串', extractOpeningConclusion('') === '')
  }

  // ---------- ② 落库 / 读回 ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w6')
    const saved = await saveOpeningSnapshot('p-w6', '一句话定调：能签', { chapterId: 'c1' })
    ok('结论落库成功', saved === true)
    const back = await readOpeningSnapshot('p-w6')
    ok('读回结论原话', back?.conclusion === '能签', JSON.stringify(back))
    ok('带来源与时间、章节归属', back?.source === OPENING_SOURCE && !!back?.at && back?.chapterId === 'c1')
    const raw = await getSettingFor<OpeningSnapshot | null>('p-w6', OPENING_SNAPSHOT_KEY, null)
    ok('只存结论一句（不复制整篇报告）', !!raw && Object.keys(raw).sort().join(',') === 'at,chapterId,conclusion,source', Object.keys(raw ?? {}).join(','))
    ok('空报告不落库（不覆盖上次结论）', (await saveOpeningSnapshot('p-w6', '')) === false && (await readOpeningSnapshot('p-w6'))?.conclusion === '能签')
  }

  // ---------- ③ 损坏 / 缺失 ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w6')
    ok('没有快照 → null（界面写未跑）', (await readOpeningSnapshot('p-w6')) === null)
    await db.setSetting(OPENING_SNAPSHOT_KEY, { conclusion: 123 })
    ok('损坏结构 → null（不假装有结论）', (await readOpeningSnapshot('p-w6')) === null)
    await db.setSetting(OPENING_SNAPSHOT_KEY, { conclusion: '   ' })
    ok('空结论 → null', (await readOpeningSnapshot('p-w6')) === null)
  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })