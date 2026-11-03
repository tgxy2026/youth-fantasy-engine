// ============ 便携版 · 语义检索 / 知识库并入整库 JSON（方案 A）============
//
// 本用例盯五件事：
//   ① base64 编解码往返 —— `Float32Array` 的真实字节**逐位不丢**（向量错了召回全废）；
//   ② 便携向量后端六方法全通：load / bulkPut / delByRef / clearProject / stats / index；
//   ③ `index()` 的 hash 键格式**与 IDB 后端逐字一致**（`chunkKey` 口径）——
//      这是增量重建的地基，键错了会把「已有块」认成「没有」⇒ 全书重复嵌入；
//   ④ 便携知识库后端七方法全通（docs + bodies 两个 store）；
//   ⑤ 安装/卸载语义：非 PORTABLE 不生效、重复调用幂等。
//
// 🔴 为什么必须有这份测试（2026-10-10 方案 A）：
//    便携版把两库数据搬进整库 JSON 是**数据契约变更** —— 一旦编解码或键格式出错，
//    后果是「U 盘里的向量全是垃圾」且**静默**（召回只是返回空/错结果，不报错）。
//    这类错误单元测试不钉住，就只能等实机上出问题才发现。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  bufferToBase64, base64ToBuffer,
  installPortableVecKb, uninstallPortableVecKb, isPortableVecKbInstalled,
  portableVecBackend, portableKbBackend,
  PORTABLE_VEC_STORE, PORTABLE_KB_DOCS_STORE, PORTABLE_KB_BODIES_STORE,
} from '../src/lib/storage/portableVecKb'
import type { SidecarApi } from '../src/lib/storage/sidecar'
import { PORTABLE_KEY_FIELDS, portableStore, setPortableSidecarApi, resetPortableSidecarApi, migratePortableSidecar } from '../src/lib/storage/fileBackend'
import {
  chunkKey, toVectorBuffer, fromVectorBuffer, vectorRowId,
} from '../src/lib/semantic/chunk'
import {
  loadVectors, putVectors, removeByRef, clearProjectVectors, vectorStats, vectorIndex,
  makeVecRow, setVecBackend, refKeyOf,
} from '../src/lib/semantic/store'
import {
  listDocs, getDocText, setKbBackend, type KbDoc,
} from '../src/lib/search/knowledgeBase'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

// 🔴 外置通道注入（2026-10-11）：vecRows / kbDocs / kbBodies 已从整库 JSON 挪到**独立文件**，
//    Node 单测里没有便携服务 ⇒ 默认 HTTP 通道必然失败，读出来全是空，与被测逻辑无关。
//    故注入一份内存实现（生产者是 setPortableSidecarApi 那个注入点）。
const memFiles = new Map<string, unknown>()
const memSidecar: SidecarApi = {
  async read(store, id) { return memFiles.get(`${store}/${id}`) },
  async write(store, id, value) { memFiles.set(`${store}/${id}`, value); return true },
  async remove(store, id) { return memFiles.delete(`${store}/${id}`) },
  async listIds(store) {
    const p = store + '/'
    return [...memFiles.keys()].filter(k => k.startsWith(p)).map(k => k.slice(p.length))
  },
}
setPortableSidecarApi(memSidecar)

// 残留自清：模块级单例在测试进程内跨用例共享，开头先清空便携 store 的三个专属表
async function resetPortableStores() {
  for (const s of [PORTABLE_VEC_STORE, PORTABLE_KB_DOCS_STORE, PORTABLE_KB_BODIES_STORE]) {
    const rows = await portableStore.getAll<{ id: string }>(s)
    if (rows.length) await portableStore.bulkDel(s, rows.map(r => r.id))
  }
}

const f32 = (nums: number[]): Float32Array => Float32Array.from(nums)

// ============ ① base64 往返 ============
{
  // 用带小数的真实浮点，确保不是「整数凑巧对」
  const src = f32([0.123456789, -1.5, 3.14159265, 1e-7, 12345.678])
  const buf = toVectorBuffer(src)
  const b64 = bufferToBase64(buf)
  const back = base64ToBuffer(b64)

  ok('base64 往返：长度一致', back.byteLength === buf.byteLength, `${back.byteLength} vs ${buf.byteLength}`)
  const round = fromVectorBuffer(back)
  let same = round.length === src.length
  for (let i = 0; same && i < src.length; i++) same = round[i] === src[i]
  ok('base64 往返：Float32 逐位不丢（含小数/负数/极小值）', same)

  ok('base64 空 buffer 不炸', base64ToBuffer(bufferToBase64(new ArrayBuffer(0))).byteLength === 0)

  // 🔴 畸形 base64（2026-10-11 审计：**收紧一条恒真断言**）
  //    原写法是 `ok(..., threw || true)` —— `|| true` 让条件**恒为真**，这条用例等于没测，
  //    于是「atob 抛异常」这个真问题在眼皮底下躺过去了（实测：`DOMException: Invalid character`）。
  //    现在按函数契约（注释原文：畸形返回空 buffer）钉死两条。
  let threw = false
  let got = -1
  try { got = base64ToBuffer('@@@not-base64@@@').byteLength } catch { threw = true }
  ok('base64 畸形输入：不抛异常（否则整库 load 会 reject）', threw === false)
  ok('base64 畸形输入：返回空 buffer（契约＝调用方按无效块跳过）', got === 0, `实得 ${got}`)
  // 中文 / 空格 / 截断尾部等现实中真会出现的脏数据
  for (const dirty of ['中文不是base64', '', 'AAAA=', 'A', '  ', '$$$']) {
    let t2 = false, l2 = -1
    try { l2 = base64ToBuffer(dirty).byteLength } catch { t2 = true }
    ok(`base64 脏输入「${dirty}」不抛且返回有限长度`, t2 === false && l2 >= 0, `len=${l2}`)
  }

  // 大 buffer 分块路径（> 0x8000）—— 验证 chunked String.fromCharCode 不炸栈
  const big = new Float32Array(4096 * 8) // 32K 个 float = 128KB
  for (let i = 0; i < big.length; i++) big[i] = i * 0.5
  const bigBack = fromVectorBuffer(base64ToBuffer(bufferToBase64(toVectorBuffer(big))))
  let bigSame = bigBack.length === big.length
  for (let i = 0; bigSame && i < big.length; i += 977) bigSame = bigBack[i] === big[i]
  ok('base64 大 buffer（128KB，跨分块边界）往返正确', bigSame)

  // 🔴 防御回归（2026-10-10 实测踩到的坑）：误传 Float32Array 时必须**取底层字节**，
  //    而不是 `new Uint8Array(view)` 的逐元素转字节 —— 后者会静默编出 1/4 长度。
  const asView = f32([1, 0, 0]) // 12 字节底层
  const b64View = bufferToBase64(asView as unknown as ArrayBuffer)
  ok('误传 Float32Array 视图：按底层字节编码（12 字节 = 16 字符 base64）',
    base64ToBuffer(b64View).byteLength === 12, `实得 ${base64ToBuffer(b64View).byteLength} 字节`)
  const viewBack = fromVectorBuffer(base64ToBuffer(b64View))
  ok('误传视图后仍能还原出正确向量', viewBack.length === 3 && viewBack[0] === 1)

  // 三个专属 store 已在便携 key 表登记（否则 upsertRows 定位不到主键 ⇒ 静默不写入）
  ok('PORTABLE_KEY_FIELDS 含 vecRows/kbDocs/kbBodies 且主键为 id',
    PORTABLE_KEY_FIELDS.vecRows === 'id' &&
    PORTABLE_KEY_FIELDS.kbDocs === 'id' &&
    PORTABLE_KEY_FIELDS.kbBodies === 'id')
}

// ============ ② 便携向量后端全方法（注入后端，走两库对外 API 全链路）============
await (async () => {
  await resetPortableStores()
  // 🔴 真正注入便携后端（而非桩）—— 这正是「方案 A 生效后」的运行时状态
  setVecBackend(portableVecBackend)

  const mk = (refId: string, chunkIdx: number, vec: number[], extra: Record<string, unknown> = {}) =>
    makeVecRow({
      projectId: 'p1', kind: 'chapter', refId, chunkIdx,
      text: `块${chunkIdx}`, title: '第一章', hash: `h-${refId}-${chunkIdx}`,
      // 🔴 `makeVecRow` 要的是 `ArrayBuffer`（见 VecRow.vec），不是 Float32Array ——
      //    传 Float32Array 会让下游 base64 编出错误字节数（这是本用例第一版踩到的坑）。
      vec: toVectorBuffer(f32(vec)), dim: vec.length, model: 'm1', secret: false, ...extra,
    } as never)

  await putVectors([
    mk('c1', 0, [1, 0, 0]),
    mk('c1', 1, [0, 1, 0]),
    mk('c2', 0, [0, 0, 1]),
  ])
  const loaded = await loadVectors('p1')
  ok('便携后端 load 返回本项目 3 行', loaded.length === 3)
  ok('便携后端 load 的 vec 已还原为 ArrayBuffer（非 base64）',
    loaded[0].vec instanceof ArrayBuffer && loaded[0].vec.byteLength === 12)

  // vec 内容逐位还原
  const back = fromVectorBuffer(loaded.find(r => r.refId === 'c1' && r.chunkIdx === 0)!.vec)
  ok('便携后端 load 的向量内容逐位一致', back[0] === 1 && back[1] === 0 && back[2] === 0)

  const st = await vectorStats('p1')
  ok('便携后端 stats：2 章 3 块', st?.chapters === 2 && st?.chunks === 3 && st?.model === 'm1')

  const idx = await vectorIndex('p1')
  ok('便携后端 index：hashes=3, refs=2', idx.hashes.size === 3 && idx.refs.size === 2)
  ok('便携后端 index 的键格式与 chunkKey 一致',
    idx.hashes.has(chunkKey('chapter', 'c1', 0)) && idx.hashes.get(chunkKey('chapter', 'c2', 0)) === 'h-c2-0')
  ok('便携后端 index 的 refs 为 kind::refId',
    idx.refs.has(refKeyOf('chapter', 'c1')) && idx.refs.has(refKeyOf('chapter', 'c2')))

  // 同 id 覆盖（幂等 upsert）
  await putVectors([mk('c1', 0, [9, 9, 9])])
  const afterUpsert = await loadVectors('p1')
  ok('便携后端 bulkPut 同主键覆盖不增行', afterUpsert.length === 3)

  // 按来源删
  await removeByRef('p1', 'c1')
  const afterDel = await loadVectors('p1')
  ok('便携后端 delByRef 只删该来源（余 c2 一行）',
    afterDel.length === 1 && afterDel[0].refId === 'c2')

  // 跨项目隔离
  await putVectors([mk('c1', 0, [1, 1, 1], { projectId: 'p2' } as never)])
  ok('便携后端按 projectId 隔离（p1 仍 1 行）', (await loadVectors('p1')).length === 1)
  ok('便携后端 p2 有自己的一行', (await loadVectors('p2')).length === 1)

  // 清项目
  await clearProjectVectors('p1')
  ok('便携后端 clearProject 只清本项目', (await loadVectors('p1')).length === 0 && (await loadVectors('p2')).length === 1)

  await clearProjectVectors('p2')
  setVecBackend(null) // 复位，避免污染同进程其它用例
  await resetPortableStores()
})()

// ============ ②b 便携 KB 后端全方法（注入后端，走对外 API）============
await (async () => {
  await resetPortableStores()
  setKbBackend(portableKbBackend)

  const doc = (id: string, projectId: string, importedAt: number, enabled = false) => ({
    id, projectId, title: `资料${id}`, sourceType: 'paste' as const,
    chars: 4, chunkCount: 0, importedAt, enabled,
  })
  await portableKbBackend.put(doc('d1', 'p1', 100))
  await portableKbBackend.put(doc('d2', 'p1', 200))
  await portableKbBackend.put(doc('d3', 'p2', 300))
  await portableKbBackend.putBody('d1', '正文一')
  await portableKbBackend.putBody('d2', '正文二')

  const list = await listDocs('p1')
  ok('便携 KB list 只返回本项目且按导入时间倒序',
    list.length === 2 && list[0].id === 'd2' && list[1].id === 'd1')
  ok('便携 KB getDocText 取回正文', (await getDocText('d1')) === '正文一')
  ok('便携 KB 不存在的 id 取正文返回空串', (await getDocText('nope')) === '')

  await portableKbBackend.del('d1')
  await portableKbBackend.delBody('d1')
  ok('便携 KB 删文档后列表减少', (await listDocs('p1')).length === 1)

  await portableKbBackend.clearProject('p1')
  ok('便携 KB clearProject 清掉本项目全部文档', (await listDocs('p1')).length === 0)
  ok('便携 KB clearProject 连带清正文（d2 正文已无）', (await getDocText('d2')) === '')
  ok('便携 KB 不误删其它项目（p2 仍在）', (await listDocs('p2')).length === 1)

  await portableKbBackend.clearProject('p2')
  setKbBackend(null)
  await resetPortableStores()
})()

// ============ ③ 键格式与 IDB 后端一致（源码断言 + 运行时等价）============
{
  const storeSrc = read('src/lib/storage/portableVecKb.ts')
  ok('桥的 index() 复用 chunkKey（不手拼键）', /hashes\.set\(chunkKey\(/.test(storeSrc))
  ok('桥未出现手拼的键分隔符（禁止 `${kind}|...`）', !/hashes\.set\(`\$\{r\.kind\}/.test(storeSrc))

  // 运行时等价：chunkKey 与 IDB 后端（semantic/store.ts）用的是同一个函数
  const semanticSrc = read('src/lib/semantic/store.ts')
  ok('IDB 后端同样用 chunkKey（两处同源）', /chunkKey\(r\.kind, r\.refId, r\.chunkIdx\)/.test(semanticSrc))

  ok('chunkKey 实际拼法为 kind::refId::idx',
    chunkKey('chapter', 'c1', 2) === 'chapter::c1::2')
  ok('vectorRowId 与 chunkKey 分隔符同族',
    vectorRowId('p1', 'chapter', 'c1', 2) === 'p1::chapter::c1::2')
}

// ============ ④ 安装语义（幂等 / 非 PORTABLE 不生效）============
{
  uninstallPortableVecKb()
  ok('初始未安装', !isPortableVecKbInstalled())

  // 测试环境 PORTABLE 为 false（无 window.__YFE_PORTABLE__ 注入）
  installPortableVecKb()
  ok('非便携模式下 install 不生效（桌面红线：两库保持独立 IDB）', !isPortableVecKbInstalled())

  uninstallPortableVecKb()
  ok('卸载后仍未安装', !isPortableVecKbInstalled())

  // 源码断言：install 有 PORTABLE 守卫 + installed 幂等守卫
  const src = read('src/lib/storage/portableVecKb.ts')
  ok('install 有 `!PORTABLE || installed` 守卫', /if \(!PORTABLE \|\| installed\) return/.test(src))
  ok('install 同时切 vec 与 kb 两个后端', /setVecBackend\(portableVecBackend\)/.test(src) && /setKbBackend\(portableKbBackend\)/.test(src))
  ok('uninstall 复位为 null（回默认 IDB 后端）', /setVecBackend\(null\)/.test(src) && /setKbBackend\(null\)/.test(src))
}

// ============ ⑤ 便携 KB 后端契约（store 级等价）============
await (async () => {
  await resetPortableStores()
  const doc: KbDoc = {
    id: 'd1', projectId: 'p1', title: '资料一', sourceType: 'paste',
    chars: 10, chunkCount: 0, importedAt: 1, enabled: true,
  }
  await portableStore.put(PORTABLE_KB_DOCS_STORE, doc)
  await portableStore.put(PORTABLE_KB_BODIES_STORE, { id: 'd1', text: '正文内容' })

  const list = await portableStore.getAllByIndex<KbDoc>(PORTABLE_KB_DOCS_STORE, 'projectId', 'p1')
  ok('KB docs 可按 projectId 索引取回', list.length === 1 && list[0].title === '资料一')

  const body = await portableStore.get<{ id: string; text: string }>(PORTABLE_KB_BODIES_STORE, 'd1')
  ok('KB bodies 可按 id 取回正文', body?.text === '正文内容')

  await portableStore.del(PORTABLE_KB_DOCS_STORE, 'd1')
  await portableStore.del(PORTABLE_KB_BODIES_STORE, 'd1')
  const after = await portableStore.getAll<{ id: string }>(PORTABLE_KB_DOCS_STORE)
  const afterBody = await portableStore.getAll<{ id: string }>(PORTABLE_KB_BODIES_STORE)
  ok('删文档连带删正文（两 store 各清空）', after.length === 0 && afterBody.length === 0)

  ok('KB 后端源码里 clearProject 同时删 docs 与 bodies',
    /del\(PORTABLE_KB_DOCS_STORE, d\.id\)/.test(read('src/lib/storage/portableVecKb.ts')) &&
    /del\(PORTABLE_KB_BODIES_STORE, d\.id\)/.test(read('src/lib/storage/portableVecKb.ts')))

  await resetPortableStores()
})()

// ============ ⑥ 整库 JSON 往返（导出 → 导入后向量/资料仍在）============
await (async () => {
  const { portableDataJSON, replacePortableData } = await import('../src/lib/storage/fileBackend')

  // 往三个专属 store 塞数据（模拟便携运行后的状态）
  const rowId = 'p1::chapter::c1::0'
  await portableStore.put(PORTABLE_VEC_STORE, {
    id: rowId, projectId: 'p1', refKey: 'chapter::c1', kind: 'chapter', refId: 'c1',
    chunkIdx: 0, text: '正文', title: '第一章', hash: 'h1', dim: 2,
    model: 'm1', secret: false, updatedAt: 5, vecB64: bufferToBase64(toVectorBuffer(f32([0.5, 0.25]))),
  })
  await portableStore.put(PORTABLE_KB_DOCS_STORE, {
    id: 'k1', projectId: 'p1', title: '参考', sourceType: 'txt',
    chars: 3, chunkCount: 0, importedAt: 2, enabled: false,
  })
  await portableStore.put(PORTABLE_KB_BODIES_STORE, { id: 'k1', text: '引文' })

  // await：外置数据要一份份读回来内联（否则导出的文件会静默丢掉全部载荷）
  const json = await portableDataJSON()
  ok('整库 JSON 含 vecRows', json.includes('vecRows'))
  ok('整库 JSON 含 kbDocs 与 kbBodies', json.includes('kbDocs') && json.includes('kbBodies'))
  ok('整库 JSON 里向量是 base64 串（不是 JSON 对象/数组）', /"vecB64":"[A-Za-z0-9+/=]+"/.test(json))

  // 清空后导入同一份 JSON，数据应完整回来
  await resetPortableStores()
  const empty = await portableStore.getAll<{ id: string }>(PORTABLE_VEC_STORE)
  ok('清空后 vecRows 为空', empty.length === 0)

  const parsed = JSON.parse(json)
  replacePortableData(parsed)
  // 🔴 导入的文件里外置数据是**内联**的 ⇒ 必须走迁移拆回外置文件，否则读不到
  await migratePortableSidecar()
  const back = await portableStore.get<{ id: string; vecB64: string }>(PORTABLE_VEC_STORE, rowId)
  ok('导入后向量行回来且 vecB64 完好', !!back && back.vecB64 === bufferToBase64(toVectorBuffer(f32([0.5, 0.25]))))
  const backKb = await portableStore.get<{ id: string }>(PORTABLE_KB_DOCS_STORE, 'k1')
  ok('导入后 KB 文档回来', backKb?.id === 'k1')

  // 从导入的 base64 还原出可用向量
  const vec = fromVectorBuffer(base64ToBuffer(back!.vecB64))
  ok('导入后向量可还原为 Float32（逐位一致）', vec[0] === 0.5 && vec[1] === 0.25)

  await resetPortableStores()
})()

// ============ ⑥b 坏数据隔离：一条坏向量不得掀翻整个库 ============
//
// 🔴 这是 2026-10-11 审计 P1-3 的**价值所在**。`fromStored` 会为每一行调 `base64ToBuffer`，
//    而 `load()` 是 `rows.map(fromStored)` —— 在修复前，只要数据文件里**有任意一条** vecB64 损坏
//    （网盘同步截断 / 手工编辑过 JSON / 磁盘坏块，都很常见），`map` 抛错 ⇒ `load()` 整体 reject
//    ⇒ 语义检索与知识库**全部无结果且不报错**（上层把失败降级成"没召回"），作者只会觉得
//    "搜索坏了"，永远查不到真因。
//    修好后应当是：坏的那条向量退化为空 buffer（按无效块跳过），**其它好数据照常返回**。
await (async () => {
  await resetPortableStores()
  const pid = 'p-badrow'
  // 🔴 vec 必须是 ArrayBuffer（不是 Float32Array）—— 与 §② 的 mk() 同口径，见那边的注释
  const good = makeVecRow({
    projectId: pid, kind: 'chapter', refId: 'r1', chunkIdx: 0,
    text: '块0', title: '第一章', hash: 'h1',
    vec: toVectorBuffer(f32([1, 2, 3])), dim: 3, model: 'm1', secret: false,
  } as never)
  await portableStore.bulkPut(PORTABLE_VEC_STORE, [
    toStoredRowLike(good),
    // 一条被"同步截断"的坏行：vecB64 不是合法 base64
    { id: 'bad-row', projectId: pid, kind: 'chapter', refId: 'r2', chunkIdx: 0, hash: 'h2', vecB64: '@@@截断@@@' },
  ])

  let rows: Awaited<ReturnType<typeof portableVecBackend.load>> | null = null
  let rejected = false
  try { rows = await portableVecBackend.load(pid) } catch { rejected = true }

  ok('⑥b 含一条坏向量时 load() **不 reject**（这是修复前的行为：会抛）', rejected === false)
  ok('⑥b 好数据仍在（不会因为一条坏行就整库读不出来）', (rows?.length ?? 0) === 2, `实得 ${rows?.length ?? 0}`)
  const goodRow = rows?.find(r => r.refId === 'r1')
  ok('⑥b 好行的向量仍逐位正确', !!goodRow && fromVectorBuffer(goodRow.vec).length === 3 && fromVectorBuffer(goodRow.vec)[0] === 1)
  const badRow = rows?.find(r => r.refId === 'r2')
  ok('⑥b 坏行的向量退化为空 buffer（按无效块跳过，不污染其它行）', badRow?.vec.byteLength === 0,
    `实得 ${badRow?.vec.byteLength}`)

  // stats / index 也不能被坏行带崩（它们是 load 的下游）
  let sOk = true, iOk = true
  try { await portableVecBackend.stats(pid) } catch { sOk = false }
  try { await portableVecBackend.index(pid) } catch { iOk = false }
  ok('⑥b stats() 不被坏行带崩', sOk)
  ok('⑥b index() 不被坏行带崩', iOk)

  await resetPortableStores()
})()

/** 把一条好行转成落盘形态（与 src 侧 toStored 同口径，供坏数据用例造数据） */
function toStoredRowLike(r: ReturnType<typeof makeVecRow>): Record<string, unknown> {
  const { vec, ...rest } = r
  return { ...rest, vecB64: bufferToBase64(vec) }
}

// ============ ⑦ 模块导出面 + 全局后端复位 ============
//
// ⚠️ Node 里 `window.__YFE_PORTABLE__` 不存在 ⇒ `PORTABLE=false`，`installPortableVecKb()` 不生效。
//    故「装桥后两库走便携后端」这条**已由 §②/§②b 直接注入 `portableVecBackend` /
//    `portableKbBackend` 覆盖**（那正是 install 生效后的运行时状态）。本节只钉导出面与复位卫生。
{
  ok('模块导出 installPortableVecKb 为函数', typeof installPortableVecKb === 'function')
  ok('模块导出 uninstallPortableVecKb 为函数', typeof uninstallPortableVecKb === 'function')
  ok('模块导出 isPortableVecKbInstalled 为函数', typeof isPortableVecKbInstalled === 'function')
  ok('模块导出两个后端对象（供单测注入）',
    typeof portableVecBackend === 'object' && typeof portableKbBackend === 'object')
  ok('两个后端均实现全部接口方法',
    ['load', 'bulkPut', 'delByRef', 'clearProject', 'stats', 'index'].every(k => typeof (portableVecBackend as never as Record<string, unknown>)[k] === 'function') &&
    ['list', 'put', 'del', 'getBody', 'putBody', 'delBody', 'clearProject'].every(k => typeof (portableKbBackend as never as Record<string, unknown>)[k] === 'function'))

  // 卫生：复位全局后端，避免影响同进程其它测试文件
  setVecBackend(null)
  setKbBackend(null)
  // 🔴 2026-10-12 全量审计：本文件在**模块顶部**注入过 memSidecar，此前**漏了复位** ——
  //    与上面两行同一目的（同进程的其它测试文件不该继承这份内存外置通道）。
  //    这条同时让 `resetPortableSidecarApi` 从「写了没人用」变成真正被使用的测试接缝。
  resetPortableSidecarApi()
}

// ============ 汇总 ============
console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
