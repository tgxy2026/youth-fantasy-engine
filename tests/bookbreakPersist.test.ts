// ============ 拆书落库（写入正文卷/章）的回归用例 ============
//
// 这条链路是 2026-09-18 新增的**写库通道**，三个"错了也不报错"的高危点必须钉死：
//   ① 分层 —— 「卷一」是卷边界不是章；分层错了会把卷名当成一章正文塞进正文编辑；
//   ② 只追加 —— 绝不能覆盖/挪动项目里已有的卷章（用户可能已经写了几十章）；
//   ③ 重复导入 —— 同一本书跑两遍会复制成两份，必须有确定性守卫拦住。
// 另外验证：章节号要接在已有内容之后**连续**（否则卷台账的「第N章」会从 1 重来）。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { persistSplitToChapters, planVolumes } from '../src/lib/bookbreak/persist'
import { splitNovelText, type SplitResult } from '../src/lib/bookbreak/split'
import { chapterSeqMap, flattenChapters } from '../src/lib/chapterSeq'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const PID = 'bookbreak-persist-test'
db.setCurrentProject(PID)

/** 手工造一个切分结果（比跑 splitNovelText 更可控） */
function mkSplit(items: { title: string; text: string }[]): SplitResult {
  const chapters = items.map((it, i) => ({
    index: i + 1, title: it.title, text: it.text, charStart: 0, charEnd: it.text.length,
  }))
  return { chapters, mode: 'chapters', stats: { count: chapters.length, chars: 0, estTokens: 0, truncated: false } }
}

// ---------- ① planVolumes：分层 ----------
{
  const sp = mkSplit([
    { title: '第1章 风起云州', text: '陈渊走出青岚宗。' },      // 卷边界之前 → 默认卷
    { title: '卷一', text: '' },                                // 卷边界
    { title: '第2章 剑鸣中州', text: '萧景行入京。' },
    { title: '第3章 血月夜', text: '玄真子现身。' },
  ])
  const plan = planVolumes(sp)
  ok('分成 2 卷（默认卷 + 卷一）', plan.volumes.length === 2, String(plan.volumes.length))
  ok('  · 默认卷名为「导入原文」', plan.volumes[0]?.title === '导入原文', plan.volumes[0]?.title)
  ok('  · 默认卷 1 章、卷二 2 章', plan.volumes[0]?.chapters.length === 1 && plan.volumes[1]?.chapters.length === 2,
    `${plan.volumes[0]?.chapters.length}/${plan.volumes[1]?.chapters.length}`)
  ok('  · 卷名取自原文「卷一」', plan.volumes[1]?.title === '卷一', plan.volumes[1]?.title)
  ok('  · 总数 = 3 章', plan.chapterCount === 3, String(plan.chapterCount))
  ok('  · 卷名没有被当成一章正文', !plan.volumes.some(v => v.chapters.some(c => c.title === '卷一')),
    plan.volumes.flatMap(v => v.chapters.map(c => c.title)).join(','))
}

{
  const sp = mkSplit([
    { title: '卷一', text: '本卷讲少年出山。' },   // 卷边界**自带正文** → 变成「卷首」
    { title: '第1章 出山', text: '陈渊下山。' },
    { title: '卷二', text: '' },                    // 空卷，末尾 → 应被丢弃
  ])
  const plan = planVolumes(sp)
  ok('卷标题自带的正文不丢（落成「卷首」章）',
    plan.volumes[0]?.chapters[0]?.title === '卷首', plan.volumes[0]?.chapters.map(c => c.title).join(','))
  ok('末尾空卷被丢弃（不留空壳卷）', plan.volumes.length === 1, String(plan.volumes.length))
}

{
  const sp = mkSplit([{ title: '第1章', text: '甲。' }, { title: '第2章', text: '乙。' }])
  const plan = planVolumes(sp, { volumeTitle: '我的书' })
  ok('无卷结构 → 单卷，卷名可用参数指定', plan.volumes.length === 1 && plan.volumes[0]!.title === '我的书',
    plan.volumes.map(v => v.title).join(','))
}

// ---------- ② 落库：写入 + 章节号接续 ----------
{
  // 预置：项目里已有一卷一章（模拟"用户已经在写了"）
  const now = Date.now()
  const v0: Volume = { id: 'v-old', projectId: PID, order: 0, title: '已有卷', description: '', createdAt: now }
  await db.saveVolume(v0)
  const c0: Chapter = {
    id: 'c-old', projectId: PID, volumeId: v0.id, order: 0, title: '已有第一章',
    content: '旧正文。', summary: '旧概要', status: '草稿', wordCount: 3, createdAt: now, updatedAt: now,
  }
  await db.saveChapter(c0)

  const sp = splitNovelText(
    '第1章 风起云州\n陈渊负剑走出青岚宗的山门。\n\n第2章 剑鸣中州\n萧景行在中州见到了玄真子。\n',
  )
  const r = await persistSplitToChapters(sp, { volumeTitle: '导入原文' })
  ok('写入 1 卷 2 章', r.volumes.length === 1 && r.chaptersCreated === 2, JSON.stringify(r.volumes))
  ok('  · alreadyImported=false、未中止', !r.alreadyImported && !r.aborted)
  ok('  · 统计了字数（>0）', r.words > 0, String(r.words))

  const vols = await db.getAllVolumes()
  const chs = await db.getAllChapters()
  ok('🔴 已有卷章分毫不动', chs.some(c => c.id === 'c-old' && c.summary === '旧概要' && c.content === '旧正文。'))
  ok('  · 新卷接在已有卷之后（order=1）', vols.find(v => v.title === '导入原文')?.order === 1,
    String(vols.find(v => v.title === '导入原文')?.order))
  ok('  · 总章数 = 3（1 旧 + 2 新）', chs.length === 3, String(chs.length))

  // 章节号必须接在已有之后：旧的 1，新的 2、3（而不是从 1 重来）
  const seq = chapterSeqMap(vols, chs)
  const newIds = [...seq.keys()].filter(id => id !== 'c-old')
  const nums = newIds.map(id => seq.get(id)).sort((a, b) => (a ?? 0) - (b ?? 0))
  ok('🔴 新章节号接续（旧=1，新=2/3）', seq.get('c-old') === 1 && nums[0] === 2 && nums[1] === 3,
    `old=${seq.get('c-old')} new=${nums.join(',')}`)
  ok('  · 叙事位次连续（flatten 长度=3）', flattenChapters(vols, chs).length === 3)
  ok('  · 章节状态标为「完稿」（原文本来就是写完的）',
    chs.filter(c => c.projectId === PID && c.volumeId !== 'v-old').every(c => c.status === '完稿'))

  // 卷台账（章节总表靠它聚合）必须同步，否则正文有了、台账是空的
  const newVol = vols.find(v => v.title === '导入原文')!
  const rows = await db.getTableRows(`chapter-vol-${newVol.id}`)
  ok('🔴 卷台账已同步出 2 行', rows.length === 2, String(rows.length))
  ok('  · 台账行带章节标题与章节号',
    rows.some(r => r.data['章节标题'] === '第1章 风起云州') && rows.some(r => r.data['章节号'] === '第3章'),
    rows.map(r => `${r.data['章节号']}:${r.data['章节标题']}`).join(' | '))
}

// ---------- ③ 重复导入守卫 ----------
{
  const sp = splitNovelText(
    '第1章 风起云州\n陈渊负剑走出青岚宗的山门。\n\n第2章 剑鸣中州\n萧景行在中州见到了玄真子。\n',
  )
  const before = (await db.getAllChapters()).length
  const r2 = await persistSplitToChapters(sp, { volumeTitle: '导入原文' })
  ok('🔴 同一本书第二次导入被识别并跳过', r2.alreadyImported === true, JSON.stringify(r2))
  ok('  · 没有多写任何章节', (await db.getAllChapters()).length === before,
    `${before} → ${(await db.getAllChapters()).length}`)
}

// ---------- ④ 中止：只写一部分，如实回报 ----------
{
  const sp = mkSplit(Array.from({ length: 10 }, (_, i) => ({ title: `第${i + 1}章`, text: `第${i + 1}章正文内容。` })))
  const ctl = new AbortController()
  let seen = 0
  const r = await persistSplitToChapters(sp, {
    volumeTitle: '半途卷',
    signal: ctl.signal,
    onProgress: done => { seen = done; if (done === 3) ctl.abort() },
  })
  ok('🔴 中止后 aborted=true', r.aborted === true, JSON.stringify({ aborted: r.aborted, n: r.chaptersCreated }))
  ok('  · 只写入了一部分（3 章）', r.chaptersCreated === 3, String(r.chaptersCreated))
  ok('  · 进度回调走到了中止点', seen === 3, String(seen))
  const chs = await db.getAllChapters()
  ok('  · 库里确实只有这 3 章（没有多写）', chs.filter(c => c.volumeId === r.volumes[0]?.id).length === 3,
    String(chs.filter(c => c.volumeId === r.volumes[0]?.id).length))
}

console.log(`\n—— bookbreakPersist 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
