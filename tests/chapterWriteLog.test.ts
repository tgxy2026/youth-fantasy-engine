// ============ 章节写入回执与恢复契约闸（3.6.0 · E）============
//
// 盯五件事：
//   ① 先落准备记录、再写正文（写不成准备记录就不写正文）；
//   ② 崩溃后只用**预分配章节 id**核对，不按章名/时间/相似度猜；
//   ③ 不重放：核对到已写入就标 committed，绝不再写一次；
//   ④ 摘要「失败」与「本来没有」必须分开；
//   ⑤ 正文/摘要/设定/总表各自分步回执，不宣传整章事务。
import { readFileSync } from 'node:fs'
import {
  CHAPTER_WRITE_LIMIT, abandonChapterWrite, chapterWriteIssues, commitChapterWrite,
  loadChapterWrites, loadPendingChapterWrites, prepareChapterWrite, receiptIssues, recoverChapterWrites,
} from '@/lib/outline/chapterWriteLog'
import { commitEntities } from '@/lib/settings/settingLedger'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { isSensitiveMetaKey } from '@/lib/storage/sensitiveMeta'
import { invalidateStorageContext } from '@/lib/storage/contextEpoch'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

const input = (over: Partial<Parameters<typeof prepareChapterWrite>[0]> = {}) => ({
  projectId: 'p-w', chapterId: 'ch-1', volumeId: 'vol-1', plannedNo: 3,
  title: '第3章 试', content: '正文内容'.repeat(50), taskId: 'task-1', ...over,
})

console.log('—— chapterWriteLog：写入回执与恢复契约闸（3.6.0 · E）——')

// ---------- ① 准备记录 ----------
{
  __resetMockStores()
  const rec = await prepareChapterWrite(input())
  ok('① 准备记录带项目/章节/卷/计划章号', rec.projectId === 'p-w' && rec.chapterId === 'ch-1' && rec.plannedNo === 3)
  ok('① 记下正文指纹与长度（不存全文）', rec.contentFingerprint.length > 0 && rec.chars > 0)
  ok('① 记下任务与存储域', rec.taskId === 'task-1' && rec.storageKey.length > 0)
  ok('① 初始状态是 prepared', (await loadPendingChapterWrites('p-w')).length === 1)
  ok('① 本机专属前缀（不随云同步）', isSensitiveMetaKey('chapterWrite::p-w'))

  // 同 id 覆盖
  await prepareChapterWrite(input({ title: '第3章 改名' }))
  const list = await loadChapterWrites('p-w')
  ok('① 同章重试不攒两条', list.length === 1 && list[0].title === '第3章 改名')

  // 滚动上限
  for (let i = 0; i < CHAPTER_WRITE_LIMIT + 5; i++) {
    await prepareChapterWrite(input({ chapterId: `ch-${i}`, title: `第${i}章` }))
  }
  ok('① 记录滚动上限 40', (await loadChapterWrites('p-w')).length === CHAPTER_WRITE_LIMIT)
}

// ---------- ② 提交与放弃 ----------
{
  __resetMockStores()
  await prepareChapterWrite(input())
  const committed = await commitChapterWrite('p-w', 'ch-1', {
    chapter: 'committed', summary: 'failed', settings: 'partial', master: 'ok', at: 10,
  })
  ok('② 提交写入回执', committed && (await loadPendingChapterWrites('p-w')).length === 0)
  const rec = (await loadChapterWrites('p-w')).find(r => r.id === 'ch-1')
  ok('② 回执四步都在', rec?.receipt?.chapter === 'committed' && rec?.receipt?.summary === 'failed'
    && rec?.receipt?.settings === 'partial' && rec?.receipt?.master === 'ok')
  ok('🔴 ② 摘要失败被单独标出（不是空摘要）', receiptIssues(rec!.receipt!).some(t => /摘要生成失败/.test(t)))

  await prepareChapterWrite(input({ chapterId: 'ch-2' }))
  const abandoned = await abandonChapterWrite('p-w', 'ch-2', 'saveChapter 失败：quota')
  const rec2 = (await loadChapterWrites('p-w')).find(r => r.id === 'ch-2')
  ok('② 放弃留下原因', abandoned && rec2?.state === 'abandoned' && /quota/.test(rec2.abandonedReason ?? ''))

  ok('② 提交不存在的操作 ⇒ false', (await commitChapterWrite('p-w', 'nope', { chapter: 'committed', summary: 'ok', settings: 'done', master: 'ok', at: 1 })) === false)
}

// ---------- ③ 崩溃恢复（只认预分配 id） ----------
{
  __resetMockStores()
  const pid = (await db.createProject('恢复')).id
  db.setCurrentProject(pid)  // getAllChapters 按当前项目过滤，测试里必须显式设上
  const chId = 'ch-real'
  // 崩溃场景 A：准备记录写下、正文没写
  await prepareChapterWrite({ projectId: pid, chapterId: 'ch-lost', volumeId: 'v', plannedNo: 1, title: '第1章 丢', content: 'x'.repeat(100) })
  // 崩溃场景 B：准备记录写下、正文也写了（模拟"写成功但回执丢了"）
  await prepareChapterWrite({ projectId: pid, chapterId: chId, volumeId: 'v', plannedNo: 2, title: '第2章 成', content: 'y'.repeat(100) })
  await db.saveChapter({
    id: chId, projectId: pid, volumeId: 'v', order: 0, title: '第2章 成',
    content: 'z'.repeat(200), summary: '', status: '草稿', wordCount: 200,
    createdAt: 1, updatedAt: 1,
  })

  const exists = async (id: string) => (await db.getAllChapters()).some(c => c.id === id)
  ok('③ 只有 B 那一章在库（崩溃态）', (await db.getAllChapters()).length === 1)

  const r1 = await recoverChapterWrites(pid, exists)
  ok('③ 核对了两条', r1.checked === 2)
  ok('🔴 ③ 没写进去的标 abandoned', r1.abandoned === 1 && (await loadPendingChapterWrites(pid)).length === 0)

  ok('🔴 ③ 已写入的标 committed（不重放）', r1.committed === 1)
  ok('🔴 ③ 恢复没有写出第二份章节', (await db.getAllChapters()).length === 1)
  const r2 = await recoverChapterWrites(pid, exists)
  ok('③ 再核对已无事可做（幂等）', r2.checked === 0)
  const rec = (await loadChapterWrites(pid)).find(x => x.id === chId)
  ok('③ 回执说明「按预分配 id 核对到已在库」', rec?.state === 'committed'
    && (rec.receipt?.notes ?? []).some(t => /不再重放/.test(t)))
  ok('③ 再跑一次是幂等的（无事可做）', (await recoverChapterWrites(pid, exists)).checked === 0)

  // 存储域变化 ⇒ 不判不清
  __resetMockStores()
  await prepareChapterWrite({ projectId: 'p-other', chapterId: 'ch-x', volumeId: 'v', plannedNo: 1, title: 't', content: 'c' })
  invalidateStorageContext()  // 存储域（账号/storage epoch）已变
  const r3 = await recoverChapterWrites('p-other', async () => false)
  ok('③ 存储域不同 ⇒ 不判（unresolved，保留记录）', r3.unresolved === 1 && (await loadPendingChapterWrites('p-other')).length === 1)
}

// ---------- ④ 接线闸（顺序与分步） ----------
{
  const auto = read('src/lib/outline/autoContinue.ts')
  ok('🔴 ④ 先落准备记录、再 saveChapter',
    /prepareChapterWrite\(/.test(auto) && auto.indexOf('prepareChapterWrite(') < auto.indexOf('await db.saveChapter(ch)'))
  ok('🔴 ④ saveChapter 失败 ⇒ 放弃记录并抛出', /abandonChapterWrite\([\s\S]{0,120}throw e/.test(auto))
  ok('④ 章节总表失败单独回执（不推翻正文已保存）',
    /masterState = 'failed'/.test(auto) && /syncChapterMaster[\s\S]{0,200}catch/.test(auto))
  ok('🔴 ④ 摘要失败与留空分开（不再 catch 成空串）',
    /summaryState = 'failed'/.test(auto) && /'ok' : 'empty'/.test(auto)
    && !/aiChapterSummary\(body[\s\S]{0,200}\.catch\(/.test(auto))
  ok('④ 四步回执写入并进入日志', /commitChapterWrite\(/.test(auto) && /stepNotes/.test(auto))
  ok('④ 预算耗尽时摘要标 skipped（不是失败）', /summaryState = 'skipped'/.test(auto))
  ok('🔴 ④ 打开项目后核对未完成写入',
    /recoverChapterWrites\(id/.test(read('src/App.tsx')))
}

// ---------- ⑤ 逐项「已写入」回执（真实写入） ----------
{
  __resetMockStores()
  const pid = (await db.createProject('逐项回执')).id
  db.setCurrentProject(pid)

  const item = {
    type: '术语' as const, name: '真气', desc: '修行者的本源之力', evidence: '',
    aliases: [], key: 'k1', status: 'new' as const,
  }
  const r1 = await commitEntities([item], '第3章 试', { pid })
  ok('⑤ 新增一条 ⇒ written 里有一条', r1.created === 1 && r1.written.length === 1)
  ok('⑤ 回执带页签与记录 id（能定位到具体那一行）',
    r1.written[0].tabId === 'terms' && !!r1.written[0].recordId && r1.written[0].merged === false)

  const rows = await db.getTableRows('terms')
  ok('🔴 ⑤ 回执里的 id 在表里真的存在（不是编的 id）',
    rows.some(x => x.id === r1.written[0].recordId))
  ok('⑤ 表里确实按名字写进去了', rows.some(x => (x.data['名称'] ?? '') === '真气'))

  // 同名再来一次 ⇒ 合并进已有行：写入但不算新增
  const r2 = await commitEntities([{ ...item, key: 'k1b' }], '第4章 试', { pid })
  ok('⑤ 同名合并 ⇒ merged: true 且 created 不加', r2.created === 0 && r2.written[0]?.merged === true)
  ok('⑤ 合并用的是同一行 id（没有重复建行）', r2.written[0].recordId === r1.written[0].recordId)

  // 人物走角色卡：回执页签应是 char-npc，且 id 在卡库里真的存在
  const r3 = await commitEntities(
    [{ ...item, key: 'k2', type: '人物', name: '林照' }], '第5章 试', { pid },
  )
  ok('⑤ 人物写进角色卡且回执标 char-npc',
    r3.written.length === 1 && r3.written[0].tabId === 'char-npc', JSON.stringify(r3))
  const cards = await db.getCardRecordsFor(pid, 'char-npc')
  ok('🔴 ⑤ 角色卡回执 id 在卡库里存在', cards.some(c => c.id === r3.written[0]?.recordId))
  ok('⑤ written 条数 === created + 合并条数（不多报也不漏报）',
    r3.written.length === r3.created + r3.written.filter(w => w.merged).length)
}

// ---------- ⑥ 章节视图分步状态（只标「欠收拾」的章） ----------
{
  __resetMockStores()
  const pid = 'p-issues'
  // 全绿的章：不该标
  const okRec = await prepareChapterWrite({ projectId: pid, chapterId: 'ch-ok', volumeId: 'v', plannedNo: 1, title: '第1章 好', content: 'x' })
  await commitChapterWrite(pid, okRec.id, { chapter: 'committed', summary: 'ok', settings: 'done', master: 'ok', at: 1 })
  // 摘要失败 + 总表未同步：该标
  const badRec = await prepareChapterWrite({ projectId: pid, chapterId: 'ch-bad', volumeId: 'v', plannedNo: 2, title: '第2章 欠', content: 'y' })
  await commitChapterWrite(pid, badRec.id, {
    chapter: 'committed', summary: 'failed', settings: 'partial', master: 'failed', at: 2,
  })
  // 还没收尾的（prepared）：不标成"欠整理"，它属于崩溃恢复的范围
  await prepareChapterWrite({ projectId: pid, chapterId: 'ch-pending', volumeId: 'v', plannedNo: 3, title: '第3章 待', content: 'z' })

  const got = await chapterWriteIssues(pid)
  ok('⑥ 全绿的章不标', !got.map.has('ch-ok'))
  ok('🔴 ⑥ 摘要失败 / 设定部分 / 总表未同步 ⇒ 该章有标记', (got.map.get('ch-bad') ?? []).length === 3)
  ok('⑥ 标记里写清欠哪一步', (got.map.get('ch-bad') ?? []).some(x => /摘要/.test(x)))
  ok('⑥ 未收尾的 prepared 不在这个标记里（那是恢复的活）', !got.map.has('ch-pending'))

  // 同一章后来又写出全绿的一版 ⇒ 旧标记必须消失（不能永久挂着琥珀点）
  const again = await prepareChapterWrite({ projectId: pid, chapterId: 'ch-bad', volumeId: 'v', plannedNo: 4, title: '第2章 欠', content: 'y2' })
  await commitChapterWrite(pid, again.id, { chapter: 'committed', summary: 'ok', settings: 'done', master: 'ok', at: 3 })
  const got2 = await chapterWriteIssues(pid)
  ok('🔴 ⑥ 同一章后来全绿 ⇒ 旧标记消失（只看最新一条）', !got2.map.has('ch-bad'))
  ok('⑥ 空项目返回空表不报错', (await chapterWriteIssues('')).map.size === 0)

  // 逐项落点条数一起带出来（界面 tooltip 用）
  const pid2 = 'p-written-count'
  const wRec = await prepareChapterWrite({ projectId: pid2, chapterId: 'ch-w', volumeId: 'v', plannedNo: 1, title: 't', content: 'x' })
  await commitChapterWrite(pid2, wRec.id, {
    chapter: 'committed', summary: 'failed', settings: 'partial', master: 'ok', at: 1,
    settingsWritten: [
      { name: 'A', tabId: 'terms', recordId: 'r1', merged: false },
      { name: 'B', tabId: 'terms', recordId: 'r2', merged: true },
    ],
  })
  const gotW = await chapterWriteIssues(pid2)
  ok('⑥ 带出「本轮设定实际写入几条」', gotW.writtenCount.get('ch-w') === 2)
}

// ---------- ⑦ 接线闸（逐项回执 / 勾选记录 / 章节标记） ----------
{
  const auto = read('src/lib/outline/autoContinue.ts')
  ok('🔴 ⑦ 四步回执里带逐项落点', /settingsWritten: r\.written/.test(auto))
  ok('🔴 ⑦ 勾选结果随结果回去（提请几条 / 勾了几条）',
    /confirm: \{ candidates: cands\.length, chosen: chosen\.length \}/.test(auto))
  ok('⑦ 取消勾选也记 candidates/chosen: 0（不混成"没经过勾选"）',
    /chosen: 0 \}/.test(auto))

  const ledger = read('src/lib/settings/settingLedger.ts')
  ok('🔴 ⑦ 写入回执从真实落库拿 id（不是估算）',
    /written\.push\(\{ name: item\.name, tabId, recordId: rec\.id/.test(ledger)
    && /written\.push\(\{ name: item\.name, tabId, recordId: row\.id/.test(ledger))

  const tree = read('src/components/editor/NovelEditorChapterTree.tsx')
  ok('🔴 ⑦ 章节树显示「正文已保存但没整理完」的标记', /chapterWriteIssues/.test(tree) && /data-chapter-write-issue/.test(tree))
  ok('🔴 ⑦ 标记的 tooltip 说清欠哪一步（不是只有一个点）', /还没收尾：\$\{writeState\.map\.get\(ch\.id\)/.test(tree))
}

console.log(`\n———— chapterWriteLog：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
