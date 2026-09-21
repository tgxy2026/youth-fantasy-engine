// ============ 章节快照：来源 / 上限裁剪 / 备份往返（2.4.0 · A3）============
//
// A3 给已存在的「时光机」补了三件事，本用例逐一钉住：
//   ① **来源标记** —— 老库里的快照没有 `source` 字段，必须按「自动」处理而不是变成 undefined；
//   ② 🔴 **裁剪优先级** —— 名额不够时**先丢最旧的自动快照**，AI 动笔前留的旧稿要保住；
//      这是 A3 最核心的一条策略，写反了（比如按时间一刀切）就会把改写前的原文丢掉；
//   ③ **备份往返** —— 只带 AI 快照进 bundle；导入后 chapterId 必须换成新 id，
//      否则快照会指向不存在的章节（界面表现：时光机里一片空白，且查不出原因）。
import fs from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import type { Chapter } from '../src/lib/types'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

__resetMockStores()
const PID = 'p-snap'
await memoryOps.put('projects', { id: PID, name: '快照测试', intro: '', cover: '', projectType: 'full', createdAt: 0, updatedAt: 0 })
db.setCurrentProject(PID)

const mkCh = (id: string, content: string): Chapter => ({
  id, projectId: PID, volumeId: 'v1', order: 0, title: `章-${id}`, content,
  summary: '', status: '草稿', wordCount: content.length, createdAt: 0, updatedAt: 0,
})

/** 直接落盘一份快照（绕过 createSnapshot，好精确控制 createdAt 与 source） */
async function seedSnap(id: string, chId: string, source: db.SnapshotSource | undefined, at: number) {
  await memoryOps.put('snapshots', {
    id, projectId: PID, chapterId: chId, chapterTitle: '章', content: `内容-${id}`,
    wordCount: 4, createdAt: at, ...(source ? { source } : {}),
  })
}
const snapsOf = async (chId: string) => (await db.getSnapshots(chId)).sort((a, b) => a.createdAt - b.createdAt)

// ---------- ① 来源语义：老数据缺字段要按「自动」处理 ----------
{
  const withSrc = { id: 's1', projectId: PID, chapterId: 'c1', chapterTitle: '章', content: 'x', wordCount: 1, createdAt: 1, source: 'ai-rewrite' as const }
  const noSrc = { id: 's2', projectId: PID, chapterId: 'c1', chapterTitle: '章', content: 'x', wordCount: 1, createdAt: 2 }
  ok('① 有来源按原值返回', db.snapshotSourceOf(withSrc as db.Snapshot) === 'ai-rewrite')
  ok('🔴 老数据缺 source → 按「自动」处理（不是 undefined）', db.snapshotSourceOf(noSrc as db.Snapshot) === 'auto')
  ok('① isAISnapshot 只认 ai- 前缀', db.isAISnapshot(withSrc as db.Snapshot) === true && db.isAISnapshot(noSrc as db.Snapshot) === false)
}

// ---------- ② createSnapshot 会写入来源 ----------
{
  const ch = mkCh('c2', '正文')
  const s = await db.createSnapshot(ch, 'ai-continue')
  ok('② 来源写进快照', s.source === 'ai-continue', String(s.source))
  const back = await snapsOf('c2')
  ok('② 落库后读回来的来源一致', back.length === 1 && back[0].source === 'ai-continue', JSON.stringify(back.map(b => b.source)))
  const s2 = await db.createSnapshot(mkCh('c2', '正文2'))
  ok('② 不传来源时默认是自动', s2.source === 'auto', String(s2.source))
}

// ---------- ③ 🔴 裁剪优先级：先丢最旧的自动快照，保住 AI 快照 ----------
{
  const chId = 'c3'
  // 12 份自动（t=1..12）+ 3 份 AI（t=20..22）＝ 15 份（已超 12，但直接落盘不触发裁剪）
  for (let i = 1; i <= 12; i++) await seedSnap(`a${i}`, chId, 'auto', i)
  for (let i = 0; i < 3; i++) await seedSnap(`ai${i}`, chId, 'ai-rewrite', 20 + i)
  // 再走一次 createSnapshot（会 put 后裁剪）
  await db.createSnapshot(mkCh(chId, '新内容'), 'auto')

  const left = await snapsOf(chId)
  const aiLeft = left.filter(s => db.isAISnapshot(s))
  ok('③ 总数被裁到上限 12 份', left.length === 12, String(left.length))
  ok('🔴 3 份 AI 快照全部保住（一份都没被裁掉）', aiLeft.length === 3, JSON.stringify(left.map(s => s.source)))
  ok('🔴 被裁的是最旧的自动快照（t=1..4 已消失）',
    !left.some(s => s.id === 'a1') && !left.some(s => s.id === 'a2') && !left.some(s => s.id === 'a3') && !left.some(s => s.id === 'a4'),
    JSON.stringify(left.map(s => s.id)))
  ok('③ 较新的自动快照仍在（t=5 未被裁）', left.some(s => s.id === 'a5'), JSON.stringify(left.map(s => s.id)))
}

// ---------- ④ 没有自动快照可牺牲时，才轮到最旧的 AI 快照 ----------
{
  const chId = 'c4'
  // 故意**不塞任何自动快照**：12 份全是 AI，再存一份就必然要裁 AI 了
  for (let i = 0; i < 12; i++) await seedSnap(`b-ai${i}`, chId, 'ai-generate', 100 + i)
  await db.createSnapshot(mkCh(chId, 'x'), 'ai-rewrite')

  const left = await snapsOf(chId)
  ok('④ 总数仍是 12 份', left.length === 12, String(left.length))
  ok('🔴 无自动快照可牺牲时，裁掉的是最旧的 AI 快照',
    !left.some(s => s.id === 'b-ai0'), JSON.stringify(left.map(s => s.id)))
  ok('🔴 新存的那一份一定被保留（不会刚存就被自己裁掉）',
    left.some(s => db.snapshotSourceOf(s) === 'ai-rewrite'),
    JSON.stringify(left.map(s => s.source)))
}

// ---------- ⑤ 每章名额独立（不同章互不挤占） ----------
{
  for (let i = 0; i < 12; i++) await seedSnap(`d${i}`, 'c5', 'auto', i + 1)
  await db.createSnapshot(mkCh('c6', '另一章'), 'ai-rewrite')
  const l5 = await snapsOf('c5')
  const l6 = await snapsOf('c6')
  ok('⑤ 另一章的快照不会挤掉本章的', l5.length === 12 && l6.length === 1, `${l5.length}/${l6.length}`)
}

// ---------- ⑥ 备份往返：只带 AI 快照 + 导入后 chapterId 重映射 ----------
{
  const pid2 = 'p-snap2'
  await memoryOps.put('projects', { id: pid2, name: '往返测试', intro: '', cover: '', projectType: 'full', createdAt: 0, updatedAt: 0 })
  await memoryOps.put('volumes', { id: 'v2', projectId: pid2, order: 0, title: '第一卷', description: '', createdAt: 0 })
  await memoryOps.put('chapters', { ...mkCh('cc1', '正文一'), projectId: pid2, volumeId: 'v2' })
  await memoryOps.put('snapshots', { id: 'k-au', projectId: pid2, chapterId: 'cc1', chapterTitle: '章', content: '自动', wordCount: 2, createdAt: 1, source: 'auto' })
  await memoryOps.put('snapshots', { id: 'k-ai', projectId: pid2, chapterId: 'cc1', chapterTitle: '章', content: 'AI 前旧稿', wordCount: 6, createdAt: 2, source: 'ai-rewrite' })

  const bundle = await db.exportProject(pid2)
  ok('⑥ 导出只带 AI 快照（定时快照不进备份）',
    (bundle.snapshots?.length ?? 0) === 1 && bundle.snapshots?.[0].content === 'AI 前旧稿',
    JSON.stringify(bundle.snapshots))

  const newPid = await db.importProject(bundle)
  const newChs = (await memoryOps.getAll<Chapter>('chapters')).filter(c => c.projectId === newPid)
  const newSnaps = (await memoryOps.getAll<db.Snapshot>('snapshots')).filter(s => s.projectId === newPid)
  ok('⑥ 导入带回 1 份 AI 快照', newSnaps.length === 1, String(newSnaps.length))
  ok('🔴 导入后快照的 chapterId 已指向新章节（不是旧 id）',
    newSnaps.length === 1 && newSnaps[0].chapterId === newChs[0].id && newSnaps[0].chapterId !== 'cc1',
    `snap.chapterId=${newSnaps[0]?.chapterId} newCh=${newChs[0]?.id}`)
  ok('⑥ 内容原样搬运', newSnaps[0]?.content === 'AI 前旧稿', JSON.stringify(newSnaps[0]?.content))

  // 自动备份那条路径必须不带快照（高频全量，带了会撑大本地存储）
  const noSnap = await db.exportProject(pid2, { includeSnapshots: false })
  ok('🔴 includeSnapshots:false 时 bundle 不带快照（自动备份走这条路）',
    (noSnap.snapshots?.length ?? 0) === 0, JSON.stringify(noSnap.snapshots))
}

// ---------- ⑦ 源码级：触发点接线没被改坏 ----------
{
  const rewrite = read('src/lib/chapterRewrite.ts')
  ok('🔴 整章改写：写前快照标成 ai-rewrite',
    /db\.createSnapshot\(ch, 'ai-rewrite'\)/.test(rewrite))
  ok('🔴 整章改写仍是「先快照、后覆盖」的顺序（反了就丢原文）',
    rewrite.indexOf('createSnapshot') < rewrite.indexOf('saveChapter(next)'),
    `snap@${rewrite.indexOf('createSnapshot')} save@${rewrite.indexOf('saveChapter(next)')}`)

  const backups = read('src/lib/db/backups.ts')
  ok('🔴 自动备份显式关掉快照（includeSnapshots: false）',
    /includeSnapshots:\s*false/.test(backups))

  const model = read('src/components/useNovelEditorModel.ts')
  ok('时光机回滚前留档标成 manual-restore',
    /createSnapshot\(active, 'manual-restore'\)/.test(model))
}

console.log(`\n—— chapterSnapshot：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exitCode = 1
