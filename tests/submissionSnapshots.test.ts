// ============ 3.7.0 · W6 复核补 ②：预检 / 探针结果快照 ============
//
// 盯三件事：只存摘要（不复制整篇报告）；能读回给体检页；缺失/损坏一律 null。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  savePlatformSnapshot, readPlatformSnapshot, saveReaderProbeSnapshot, readReaderProbeSnapshot,
  PLATFORM_SNAPSHOT_KEY, READER_PROBE_SNAPSHOT_KEY,
} from '../src/lib/audit/submissionSnapshots'
import { getSettingFor } from '@/lib/db'
import type { PlatformCheckReport } from '../src/lib/audit/platformCheck'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const report = (over: Partial<PlatformCheckReport> = {}): PlatformCheckReport => ({
  platform: 'general', platformName: '综合',
  hits: [{ word: '测试词', count: 2, focus: false } as never],
  facts: [],
  observations: ['  第1章 3200 字  ', '', '分章字数多数落在参考区间内', '命中 2 处平台重点关注类别'],
  ...over,
})

async function main() {
  // ---------- ① 平台预检 ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w6b')
    ok('落库成功', await savePlatformSnapshot('p-w6b', report()) === true)
    const back = await readPlatformSnapshot('p-w6b')
    ok('读回平台名与观察句', back?.platform === '综合' && back?.observations.length === 3, JSON.stringify(back))
    ok('观察句去空白、丢空串', back?.observations[0] === '第1章 3200 字')
    ok('空项目 id 不落库', await savePlatformSnapshot('', report()) === false)
    const raw = await getSettingFor<{ observations: string[] }>('p-w6b', PLATFORM_SNAPSHOT_KEY, { observations: [] })
    ok('只存摘要（无敏感词明细 / 无正文）', !JSON.stringify(raw).includes('测试词') && !JSON.stringify(raw).includes('第1章正文'))

    const many = report({ observations: Array.from({ length: 30 }, (_, i) => `观察 ${i}`) })
    await savePlatformSnapshot('p-w6b', many)
    ok('观察句最多留 12 条（不复制整篇报告）', (await readPlatformSnapshot('p-w6b'))?.observations.length === 12)
  }

  // ---------- ② 读者探针 ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w6b')
    const saved = await saveReaderProbeSnapshot('p-w6b', '追更读者', {
      notes: [{ q: 'bored', quote: '原文', at: 0, paragraph: 1, comment: '有点拖' }],
      summary: '会接着看，但第三章节奏偏慢', raw: '',
    })
    ok('探针摘要落库', saved === true)
    const back = await readReaderProbeSnapshot('p-w6b')
    ok('只存身份 + 收尾句 + 条数', back?.lens === '追更读者' && back?.notes === 1 && back?.summary.includes('接着看'), JSON.stringify(back))
    const raw = await getSettingFor<Record<string, unknown>>('p-w6b', READER_PROBE_SNAPSHOT_KEY, {})
    ok('不存逐条引文 / 正文', Object.keys(raw).sort().join(',') === 'at,lens,notes,summary', Object.keys(raw).join(','))
    ok('空收尾句不落库', await saveReaderProbeSnapshot('p-w6b', '新读者', { notes: [], summary: '   ', raw: '' }) === false)
  }

  // ---------- ③ 损坏 / 缺失 ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w6b')
    ok('没有快照 → null（体检页写未跑）',
      (await readPlatformSnapshot('p-w6b')) === null && (await readReaderProbeSnapshot('p-w6b')) === null)
    await db.setSetting(PLATFORM_SNAPSHOT_KEY, { platform: 123 })
    await db.setSetting(READER_PROBE_SNAPSHOT_KEY, { summary: '' })
    ok('损坏结构 → null', (await readPlatformSnapshot('p-w6b')) === null && (await readReaderProbeSnapshot('p-w6b')) === null)
  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })