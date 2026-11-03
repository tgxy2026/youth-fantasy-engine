// ============ 数据文件格式版本闸（3.2.6 · 矩阵 roundtrip/schema-version）============
//
// 缺陷（本文件是它的回归闸）：
//   `lib/revision/faultInjection.ts` 里早就有 `checkDataVersion()`，但它**只被单测调用**，
//   三条导入路径（桌面 / 便携+云端 / 游客）**一处都没用**。
//   而 `normalizePortableData` 是容错归一化：fileVersion 原样搬过来、不认识的新字段直接丢。
//   ⇒ 拿「新版本软件写的数据文件」到旧版本里导入会被**静默接受**，再存一次就把
//     新版本才有的字段整库抹平（不可逆）。
//
// 修复口径：
//   · 文件版本 > 当前（PORTABLE_FILE_VERSION）⇒ 拒绝，且**本机数据一个字不动**；
//   · 文件版本 = 当前，或**没有 fileVersion**（1.x 老文件按 v1）⇒ 照常导入；
//   · 版本号是脏值（0 / 负数 / 小数 / 字符串）⇒ 拒绝，理由要能看懂。
//
// 另外两条同源事实也在这里钉住：
//   · 游客导出必须写**当前**格式版本（此前写死 1，等于自我标成老格式）；
//   · 桌面读盘遇到「更新版本」必须**锁写盘**（能看不能写），不能照旧 ready。
import { ops } from '../src/lib/db/core'
import { importGuestData, guestDataObject } from '../src/lib/db/guestData'
import {
  describeFileVersionProblem, PORTABLE_FILE_VERSION, PORTABLE_FILE_MIN_VERSION,
} from '../src/lib/storage/storeOps'
import { decideDataFileLoad } from '../src/lib/app/desktop'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 纯判据 ----------
const future = PORTABLE_FILE_VERSION + 1
ok('没有 fileVersion 的老文件按 v1 接受（1.x 备份不能因为缺字段就打不开）',
  describeFileVersionProblem({ kind: 'portable-data', stores: {} }) === null)
ok('当前版本接受', describeFileVersionProblem({ fileVersion: PORTABLE_FILE_VERSION }) === null)
ok('最低版本接受', describeFileVersionProblem({ fileVersion: PORTABLE_FILE_MIN_VERSION }) === null)

for (const [label, value] of [
  ['未来版本', future],
  ['版本 0', 0],
  ['负数版本', -3],
  ['小数版本', 2.5],
  ['字符串版本', 'v2'],
] as const) {
  const msg = describeFileVersionProblem({ fileVersion: value })
  ok(`${label} 被拒且理由是中文可读`, typeof msg === 'string' && msg.length > 8 && /版本/.test(msg), String(msg))
}
ok('未来版本的拒绝语要提示「更新版本」，不能只说格式不对',
  /更新版本/.test(String(describeFileVersionProblem({ fileVersion: future }))))

// ---------- ② 游客导入：拒绝时本机数据一字不动 ----------
const PROJECT = { id: 'vg-p1', name: '既有项目', genre: '玄幻', intro: '', projectType: 'full', createdAt: 1, updatedAt: 1 }
const CHAPTER = { id: 'vg-c1', projectId: 'vg-p1', volumeId: 'vg-v1', title: '第一章', content: '既有正文-不许丢', summary: '', wordCount: 9, order: 0, status: '草稿', tags: [], createdAt: 1, updatedAt: 1 }

async function seed() {
  await ops.bulkDel('projects', ['vg-p1', 'vg-p2'])
  await ops.bulkDel('chapters', ['vg-c1', 'vg-c2'])
  await ops.put('projects', PROJECT)
  await ops.put('chapters', CHAPTER)
}
const snapshot = async () => ({
  projects: (await ops.getAll<{ id: string }>('projects')).map(r => r.id).sort(),
  chapters: (await ops.getAll<{ id: string; content?: string }>('chapters')).map(r => `${r.id}:${r.content ?? ''}`).sort(),
})

const makeFile = (fileVersion: number | undefined, extra: Record<string, unknown> = {}) => JSON.stringify({
  app: 'youth-fantasy-engine', kind: 'portable-data',
  ...(fileVersion === undefined ? {} : { fileVersion }),
  savedAt: 1,
  stores: {
    projects: [{ id: 'vg-p2', name: '导入进来的项目', genre: '玄幻', intro: '', projectType: 'full', createdAt: 2, updatedAt: 2 }],
    chapters: [{ id: 'vg-c2', projectId: 'vg-p2', volumeId: 'vg-v2', title: '导进来的章', content: '导入内容', summary: '', wordCount: 4, order: 0, status: '草稿', tags: [], createdAt: 2, updatedAt: 2 }],
  },
  ...extra,
})

await seed()
const before = await snapshot()

{
  const r = await importGuestData(makeFile(future))
  const after = await snapshot()
  ok('游客导入：未来版本被拒绝', r.ok === false, JSON.stringify(r))
  ok('游客导入：拒绝理由说清楚是版本问题', /版本/.test(String(r.error)) && /未改动/.test(String(r.error)), String(r.error))
  ok('游客导入：拒绝后本机数据逐条未变（不是"清空后才报错"）',
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
}

{
  const r = await importGuestData(makeFile(0))
  ok('游客导入：脏版本号（0）也被拒', r.ok === false && /版本/.test(String(r.error)), JSON.stringify(r))
  const after = await snapshot()
  ok('游客导入：脏版本号拒绝后数据未变', JSON.stringify(before) === JSON.stringify(after))
}

{
  // 没有 fileVersion 的老文件必须能进 —— 这是"重装/换机拿旧备份"的主路径
  const r = await importGuestData(makeFile(undefined))
  const after = await snapshot()
  ok('游客导入：没有 fileVersion 的老文件照常导入', r.ok === true, JSON.stringify(r))
  ok('游客导入：老文件的内容确实写进去了', after.projects.includes('vg-p2') && after.chapters.some(c => c.startsWith('vg-c2:导入内容')), JSON.stringify(after))
}

{
  // 当前版本当然也要能进
  await seed()
  const r = await importGuestData(makeFile(PORTABLE_FILE_VERSION))
  ok('游客导入：当前版本照常导入', r.ok === true && (await snapshot()).projects.includes('vg-p2'), JSON.stringify(r))
}

await seed()

// ---------- ③ 游客导出：版本号必须是当前格式 ----------
{
  const { data } = await guestDataObject()
  ok('游客导出写的是当前格式版本（不是写死 1）',
    data.fileVersion === PORTABLE_FILE_VERSION, `fileVersion=${String((data as { fileVersion?: unknown }).fileVersion)}`)
}

// ---------- ④ 桌面读盘：更新版本必须锁写盘，而不是照旧 ready ----------
{
  const text = makeFile(future)
  const outcome = decideDataFileLoad({ text, missing: false })
  ok('桌面读盘：未来版本锁写盘（能看不能写）', outcome.kind === 'lock', JSON.stringify(outcome).slice(0, 160))
  ok('桌面读盘：锁的原因指向版本',
    outcome.kind === 'lock' && /版本/.test(outcome.reason) && /升级/.test(outcome.error), JSON.stringify(outcome).slice(0, 200))
}
{
  const outcome = decideDataFileLoad({ text: makeFile(PORTABLE_FILE_VERSION), missing: false })
  ok('桌面读盘：当前版本正常 ready', outcome.kind === 'ready', JSON.stringify(outcome).slice(0, 120))
}
{
  const outcome = decideDataFileLoad({ text: makeFile(undefined), missing: false })
  ok('桌面读盘：老文件（无 fileVersion）正常 ready', outcome.kind === 'ready', JSON.stringify(outcome).slice(0, 120))
}

console.log(`importVersionGate: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
