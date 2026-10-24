// ============ 3.2.3 · R4：三端数据格式往返（跨形态）============
//
// 三端导出必须同格式（`kind:'portable-data'`），否则「游客导出 → 桌面导入」这类搬迁会断。
// 这里锁的是**格式契约**这一层（不启浏览器、不起 Electron）：
//   · 游客导出的「数组形态」能被便携/桌面的归一化接收，标识与正文不丢；
//   · 桌面/便携写出的「键化形态」能被归一化原样保留（不能把键化当坏数据丢掉）；
//   · 归一化是幂等的（反复导入不会越导越少）；
//   · 游客自往返（导出→导入）内容不变。
//
// 🔴 已知缺口（不在本文件断言）：`importGuestData` 只接受数组形态，喂键化形态会**先清空再导入空**。
//    实测见 `tests/importGuestShapeProbe.ts`（手动探针）与
//    `docs/3.2.3-R4游客导入形态缺口-2026-10-24.md`。这里不写成红用例，避免把已知缺陷混进绿灯基线。
import { normalizePortableData, keyOfRecord, isPortableDataFile } from '../src/lib/storage/storeOps'
import { ops } from '../src/lib/db/core'
import { importGuestData, guestDataObject } from '../src/lib/db/guestData'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PROJECT = { id: 'p1', name: '往返项目', genre: '玄幻', intro: '', projectType: 'full', createdAt: 1, updatedAt: 1 }
const CHAPTER = { id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第一章', content: '往返正文-必须逐字一致', summary: '', wordCount: 12, order: 0, status: '草稿', tags: [], createdAt: 1, updatedAt: 1 }
const ROW = { id: 'r1', projectId: 'p1', tableId: 't1', cells: { 名称: '青岚宗' } }
const PAYLOAD = { id: 'pl1', projectId: 'p1', bytes: 12, text: '备份载荷正文' }

/** 游客侧的真实导出形状：store → 行数组 */
const guestShaped = {
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 111,
  stores: { projects: [PROJECT], chapters: [CHAPTER], tableRows: [ROW], backupPayloads: [PAYLOAD] },
}
/** 桌面/便携写出的真实形状：store → 主键->记录 */
const keyedShaped = {
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 222,
  stores: {
    projects: { p1: PROJECT },
    chapters: { c1: CHAPTER },
    tableRows: { r1: ROW },
    backupPayloads: { pl1: PAYLOAD },
  },
}

const textOf = (data: ReturnType<typeof normalizePortableData>, store: string, id: string) => {
  const rows = data.stores[store]
  const rec = rows?.[id] as { content?: string } | undefined
  return rec?.content
}

async function main() {
  // ---------- ① 游客数组形态 → 归一化（便携/桌面导入必走它）----------
  {
    ok('① 数组形态被识别为本软件数据文件', isPortableDataFile(guestShaped))
    const n = normalizePortableData(guestShaped)
    ok('① 主键索引正确（按 id 而不是 0/1 数字键）',
      Object.keys(n.stores.projects).join(',') === 'p1', JSON.stringify(Object.keys(n.stores.projects)))
    ok('🔴 ① 正文逐字一致', textOf(n, 'chapters', 'c1') === CHAPTER.content, String(textOf(n, 'chapters', 'c1')))
    ok('① 载荷也在（导出必须带备份载荷）', (n.stores.backupPayloads?.pl1 as { text?: string })?.text === PAYLOAD.text)
    ok('① 其它 store 不丢', Object.keys(n.stores).length === 4, JSON.stringify(Object.keys(n.stores)))
  }

  // ---------- ② 桌面/便携键化形态 → 归一化（不能被当成坏数据丢掉）----------
  {
    const n = normalizePortableData(keyedShaped)
    ok('🔴 ② 键化形态原样保留（不是只认数组）',
      Object.keys(n.stores.chapters).join(',') === 'c1' && textOf(n, 'chapters', 'c1') === CHAPTER.content,
      JSON.stringify(n.stores.chapters))
    ok('② 记录标识与源一致', keyOfRecord('chapters', n.stores.chapters.c1) === 'c1')
    ok('② fileVersion 保留', n.fileVersion === 2, String(n.fileVersion))
  }

  // ---------- ③ 归一化幂等：反复导入不会越导越少 ----------
  {
    const once = normalizePortableData(guestShaped)
    const twice = normalizePortableData(JSON.parse(JSON.stringify(once)))
    const count = (d: ReturnType<typeof normalizePortableData>) =>
      Object.values(d.stores).reduce((n, rows) => n + Object.keys(rows).length, 0)
    ok('🔴 ③ 归一化幂等（两次与一次记录数相同）', count(once) === count(twice) && count(once) === 4, `${count(once)} vs ${count(twice)}`)
    ok('③ 第二次内容仍一致', textOf(twice, 'chapters', 'c1') === CHAPTER.content)
  }

  // ---------- ④ 被数组展开污染的老文件能救回来（历史现场）----------
  {
    const polluted = { ...guestShaped, stores: { chapters: { 0: CHAPTER, 1: { ...CHAPTER, id: 'c2', content: '第二章' } } } }
    const n = normalizePortableData(polluted)
    ok('🔴 ④ 数字键污染的老文件按真实主键重建',
      Object.keys(n.stores.chapters).sort().join(',') === 'c1,c2', JSON.stringify(Object.keys(n.stores.chapters)))
  }

  // ---------- ⑤ 游客自往返：导出 → 导入，内容与标识不变 ----------
  {
    await ops.bulkDel('projects', ['p1'])
    await ops.bulkDel('chapters', ['c1'])
    await ops.put('projects', PROJECT)
    await ops.put('chapters', CHAPTER)
    const exported = await guestDataObject()
    ok('⑤ 游客导出带齐格式标识', exported.data.kind === 'portable-data' && !!exported.data.stores)
    ok('⑤ 导出后本地数据未被清空', (await ops.getAll('chapters')).length === 1)
    const r = await importGuestData(JSON.stringify(exported.data))
    const back = (await ops.getAll<{ id: string; content: string }>('chapters'))[0]
    ok('⑤ 自往返导入成功', r.ok === true, JSON.stringify(r))
    ok('🔴 ⑤ 自往返正文与标识逐字一致', back?.id === 'c1' && back?.content === CHAPTER.content, JSON.stringify(back))
  }

  console.log(`\n———— profileRoundtrip：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
