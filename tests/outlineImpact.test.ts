// ============ 3.7.0 · W1 大纲级联影响标记 ============
//
// 盯六件事（规划 §3 W1.3）：
//   ① 三条大纲路径（总纲 form / 卷纲 row·card / 细纲 card）各自：变更前无标记 → 保存后有标记且范围正确；
//   ② 全写路径覆盖：直接调 db 收口点（模拟 AI / 导入 / MCP 写库）同样触发 —— 证明接的是 db 不是 UI；
//   ③ 保存主路径隔离：消费者/订阅者抛错时保存仍成功、数据完好；
//   ④ 批量合并：连写多次只触发一次分析（300ms 防抖，假时钟）；
//   ⑤ 章后整理：`analyzeChapterFutureImpact` 打标（兑现 futureImpact 旧注释承诺）；
//   ⑥ 已写章不误标：只进「建议复核」清单；空变更（保存未改值）不打标；证据带改前 → 改后。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import { clearDbChangeListeners, onDbChange } from '../src/lib/db/changeBus'
import {
  registerChangeWatch, setWatchClock, resetWatchStats, watchStats, whenIdle,
} from '../src/lib/revision/changeWatch'
import {
  readImpact, readReviewSuggestions, analyzeChapterFutureImpact, clearImpact,
} from '../src/lib/outline/futureImpact'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 假时钟（防抖断言的前提） ----------
type Timer = { fn: () => void; at: number }
let timers: Timer[] = []
let now = 0
setWatchClock({
  setTimeout(fn, ms) {
    const timer = { fn, at: now + ms }
    timers.push(timer)
    return timer
  },
  clearTimeout(handle) {
    timers = timers.filter(t => t !== handle)
  },
})
async function advance(ms: number) {
  now += ms
  for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
    if (timer.at > now) continue
    timers = timers.filter(t => t !== timer)
    timer.fn()
  }
  await whenIdle()
}

const MASTER = 'master'
const OUTLINE = 'chapter-outline'
const VOLUME = 'volume-outline'

const chapter = (id: string, order: number, content: string) => ({
  id, projectId: 'p1', volumeId: 'v1', order, title: id, content, wordCount: content.length, updatedAt: 1,
})
const outlineCard = (no: number) => ({
  id: `o${no}`, projectId: 'p1', tabId: OUTLINE, name: `第${no}章 标题`,
  data: { '章节号/标题': `第${no}章 标题`, '本章一句话事件': `旧事件${no}` }, order: no - 1,
})
const volumeCard = {
  id: 'vol1', projectId: 'p1', tabId: VOLUME, name: '风起云州',
  data: { '二、起止与节奏::本卷章号范围': '第1-5章', '第一大高潮': '旧高潮' }, order: 0,
}

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject('p1')
  resetWatchStats()
  timers = []
  now = 0
  await memoryOps.put('volumes', { id: 'v1', projectId: 'p1', order: 0, title: '卷一', createdAt: 1 })
  // 第 1、2 章已写；第 3–5 章只有细纲、没有正文（未开写）
  await memoryOps.put('chapters', chapter('c1', 0, '正文一'))
  await memoryOps.put('chapters', chapter('c2', 1, '正文二'))
  for (let no = 1; no <= 5; no++) await memoryOps.put('cardRecords', outlineCard(no))
  await memoryOps.put('cardRecords', volumeCard)
  await memoryOps.put('formData', { tabId: 'p1::master', data: { 主线一句话: '旧主线' } })
}

const cardOf = async (id: string) => (await memoryOps.getAll<{ id: string; data: Record<string, string>; name?: string }>('cardRecords')).find(r => r.id === id)!

async function main() {
  registerChangeWatch()

  // ---------- ① 细纲变更：> 该章的未开写章 ----------
  {
    await seed()
    const card = await cardOf('o2')
    await db.saveCardRecord({ ...card, data: { ...card.data, '本章一句话事件': '改后的新事件' } } as never)
    ok('细纲保存后、防抖未到 → 还没打标', (await readImpact()).length === 0)
    await advance(300)
    const marks = await readImpact()
    ok('细纲变更 → 第3/4/5章打标', marks.map(m => m.chapterNo).join(',') === '3,4,5', marks.map(m => m.chapterNo).join(','))
    ok('已写章（1/2）不误标', marks.every(m => m.chapterNo > 2))
    ok('原因 / 来源正确', marks.every(m => m.reason === '细纲变更' && m.origin === '第2章'))
    ok('证据带改前 → 改后', marks[0]?.evidence?.beforeSummary === '旧事件2'
      && marks[0]?.evidence?.afterSummary === '改后的新事件', JSON.stringify(marks[0]?.evidence))
    ok('细纲变更不产生「已写章建议复核」', (await readReviewSuggestions()).length === 0)
    await clearImpact()
  }

  // ---------- ② 卷纲变更：该卷范围内的未开写章 + 已写章进建议清单 ----------
  {
    await seed()
    await db.saveCardRecord({ ...volumeCard, data: { ...volumeCard.data, '第一大高潮': '新高潮' } } as never)
    await advance(300)
    const marks = await readImpact()
    ok('卷纲变更 → 范围内未开写章 3/4/5 打标', marks.map(m => m.chapterNo).join(',') === '3,4,5', marks.map(m => m.chapterNo).join(','))
    ok('卷纲变更的章号来源与原因', marks.every(m => m.fromChapterNo === 1 && m.reason === '卷纲变更' && m.origin === '《风起云州》'))
    const suggests = await readReviewSuggestions()
    ok('已写章 1/2 只进建议复核清单', suggests.map(s => s.chapterNo).join(',') === '1,2', suggests.map(s => s.chapterNo).join(','))
  }

  // ---------- ③ 总纲变更：全部未开写章 + 已写章进建议清单 ----------
  {
    await seed()
    await db.saveFormDataFor('p1', MASTER, { 主线一句话: '新主线' })
    await advance(300)
    const marks = await readImpact()
    ok('总纲变更 → 全部未开写章打标', marks.map(m => m.chapterNo).join(',') === '3,4,5', marks.map(m => m.chapterNo).join(','))
    ok('总纲标记的来源可读', marks.every(m => m.reason === '总纲变更' && m.origin === '全书总纲'))
    const suggests = await readReviewSuggestions()
    ok('总纲变更 → 已写章全部进建议清单', suggests.map(s => s.chapterNo).join(',') === '1,2', suggests.map(s => s.chapterNo).join(','))

    // 空变更：保存未改值 → 不再打标、不再进清单
    const analysesBefore = watchStats.analyses
    await db.saveFormDataFor('p1', MASTER, { 主线一句话: '新主线' })
    await advance(300)
    const after = await readImpact()
    ok('空变更不打标（标记保持不变）', after.length === marks.length && after.every((m, i) => m.chapterNo === marks[i].chapterNo))
    ok('空变更不触发分析（消费者比对前后值后跳过）', watchStats.analyses === analysesBefore, `${watchStats.analyses} vs ${analysesBefore}`)
  }

  // ---------- ④ 全写路径覆盖：直接调 db 收口点（模拟 AI / 导入 / MCP） ----------
  {
    await seed()
    // 表格行路径（卷纲以行形式被外部工具写入）
    await memoryOps.put('tableRows', {
      id: 'volrow', projectId: 'p1', tabId: VOLUME, data: { '本卷章号范围': '第1-5章', '第一大高潮': '旧' }, order: 0,
    })
    await db.saveTableRow({
      id: 'volrow', projectId: 'p1', tabId: VOLUME, data: { '本卷章号范围': '第1-5章', '第一大高潮': '新' }, order: 0,
    })
    await advance(300)
    const marks = await readImpact()
    ok('saveTableRow（非 UI 路径）同样打标', marks.map(m => m.chapterNo).join(',') === '3,4,5', marks.map(m => m.chapterNo).join(','))
    ok('行路径证据带改前 → 改后', !!marks[0]?.evidence && marks[0]?.evidence?.beforeSummary.includes('旧'), JSON.stringify(marks[0]?.evidence))
  }

  // ---------- ⑤ 保存主路径隔离：订阅者抛错 / 打标写库失败都不影响保存 ----------
  {
    await seed()
    const off = onDbChange(() => { throw new Error('listener boom') })
    const card = await cardOf('o2')
    await db.saveCardRecord({ ...card, data: { ...card.data, '本章一句话事件': '保存必须成功' } } as never)
    const stored = await cardOf('o2')
    ok('订阅者抛错时保存仍成功、数据完好', stored.data['本章一句话事件'] === '保存必须成功')
    off()

    // 打标写库失败（settingsKV 写抛错）：保存仍然成功
    const badOps = {
      ...memoryOps,
      put: async (store: string, value: unknown) => {
        if (store === 'settingsKV') throw new Error('settingsKV down')
        return memoryOps.put(store as never, value as never)
      },
    }
    await seed()
    db.setStoreOps(badOps as never)
    const card2 = await cardOf('o3')
    await db.saveCardRecord({ ...card2, data: { ...card2.data, '本章一句话事件': '写库失败也要存住' } } as never)
    await advance(300)
    ok('打标写库失败时保存仍成功', (await cardOf('o3')).data['本章一句话事件'] === '写库失败也要存住')
    ok('打标写库失败时不留下半截标记', (await readImpact()).length === 0)
    db.setStoreOps(memoryOps)
  }

  // ---------- ⑥ 批量合并：连写 100 次只分析一次 ----------
  {
    await seed()
    const card = await cardOf('o2')
    for (let i = 0; i < 1000; i++) {
      await db.saveCardRecord({ ...card, data: { ...card.data, '本章一句话事件': `第${i}稿` } } as never)
    }
    await advance(299)
    ok('299ms 时还没分析', watchStats.analyses === 0)
    await advance(1)
    ok('1000 次连写只触发一次分析', watchStats.analyses === 1, String(watchStats.analyses))
    ok('只触发一次合并刷新', watchStats.flushes === 1, String(watchStats.flushes))
    const marks = await readImpact()
    ok('合并后标记仍然正确', marks.map(m => m.chapterNo).join(',') === '3,4,5')
  }

  // ---------- ⑦ 章后整理路径（不经 changeBus，确认后直接调一次） ----------
  {
    await seed()
    const marks = await analyzeChapterFutureImpact('c2', '章后整理')
    ok('章后整理 → 该章之后的未来章打标', marks.map(m => m.chapterNo).join(',') === '3,4,5', marks.map(m => m.chapterNo).join(','))
    ok('章后整理的原因正确', (await readImpact()).every(m => m.reason === '章后整理'))
  }

  // ---------- ⑧ 源码闸：commitPost 兑现注释承诺 / 收口点接线 ----------
  {
    const fs = await import('node:fs')
    const model = fs.readFileSync('src/components/jiewenji/useJieWenJiModel.ts', 'utf8')
    ok('commitPost 成功后调 analyzeChapterFutureImpact（原因「章后整理」）',
      /analyzeChapterFutureImpact\(ch, '章后整理'/.test(model))
    const bus = fs.readFileSync('src/lib/db/changeBus.ts', 'utf8')
    ok('changeBus 每个订阅者单独 try/catch（旁路隔离）', /try \{\s*listener\(fact\)[\s\S]*?catch/.test(bus))
    const tabs = fs.readFileSync('src/lib/db/tabs.ts', 'utf8')
    ok('三个 db 收口点都发事实',
      tabs.includes("kind: 'form'") && tabs.includes("kind: 'row'") && tabs.includes("kind: 'card'"))
    const chapters = fs.readFileSync('src/lib/db/chapters.ts', 'utf8')
    ok('章节收口点（saveChapter / patchChapter / 新建）都发事实',
      (chapters.match(/emitChapterChange\(/g) ?? []).length >= 4)
    const main = fs.readFileSync('src/main.tsx', 'utf8')
    ok('应用启动注册消费者', main.includes('registerChangeWatch()'))
  }

  clearDbChangeListeners()
  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })