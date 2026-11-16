// ============ 作者成果记录 · 契约闸（3.6.0 · A1）============
//
// 盯五件会静默坏掉的事（都不会报错，只会让作者以为"成果没了"）：
//   ① 存储形态：值必须是**字符串** —— 放对象会被 exportProject 的敏感值探测误剥；
//   ② 空 / 损坏 / 更高版本三态必须分开（空＝正常，损坏＝禁止覆盖，更高＝只读）；
//   ③ 容量超限必须**拒绝并说明**，不静默淘汰作者保存的成果；
//   ④ 过期只按**实际依赖**判，过期不删除、但不可应用；
//   ⑤ 导入必须显式重映射（id 换新、悬空标 missing 并降 draft），不能靠通用 settings 搬运。
import { readFileSync } from 'node:fs'
import {
  ARTEFACT_FORMAT_VERSION, ARTEFACT_LIMITS, ARTEFACT_SETTING_KEY,
  checkArtefactWrite, emptyArtefacts, markStaleByChanges, parseArtefacts,
  remapArtefactsForImport, serializeArtefacts, utf8Bytes,
} from '@/lib/artefacts/remap'
import type { ArtefactRecord, ArtefactStore } from '@/lib/artefacts/types'
import { isSensitiveSettingKey } from '@/lib/storage/sensitiveMeta'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => readFileSync(p, 'utf8')

const rec = (over: Partial<ArtefactRecord> = {}): ArtefactRecord => ({
  id: 'ar_1',
  kind: 'analysis',
  projectId: 'p1',
  source: { chapterId: 'ch1', tabId: 'races', fingerprint: 'fp-1', quote: '短引' },
  deps: [{ kind: 'chapter', id: 'ch1', fingerprint: 'fp-1' }],
  state: 'kept',
  payload: { title: '场景作用', body: '主角第一次登台' },
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
})
const store = (items: ArtefactRecord[]): ArtefactStore => ({ formatVersion: 1, items })

console.log('—— artefacts：作者成果记录契约闸（3.6.0 · A1）——')

// ---------- ① 存储形态与敏感键 ----------
{
  const text = serializeArtefacts(store([rec()]))
  ok('① 序列化结果是字符串（不是对象）', typeof text === 'string' && text.startsWith('{'))
  ok('① 反序列化往返等值', (() => {
    const p = parseArtefacts(text)
    return p.ok && p.store.items[0].id === 'ar_1' && p.store.items[0].source.fingerprint === 'fp-1'
  })())
  // 🔴 安全回归：key 与值都不该被判成敏感 —— 否则导出时整条成果被剥掉
  ok('① 键名不被判为敏感设置', !isSensitiveSettingKey(ARTEFACT_SETTING_KEY, text))
  // 对照：若把同内容当对象放进去、且 payload 里有个叫 token 的字段，就会被剥（正是必须字符串化的原因）
  ok('① 对照：对象形态遇到 token 字段会被判敏感（证明字符串化有必要）',
    isSensitiveSettingKey(ARTEFACT_SETTING_KEY, { items: [{ payload: { token: 'x' } }] }) === true)
  ok('① key 常量与 M0 文档一致', ARTEFACT_SETTING_KEY === 'artefacts')
}

// ---------- ② 三态解析 ----------
{
  ok('② 缺失 ⇒ 空成果，不是错误', (() => {
    const p = parseArtefacts(null)
    return p.ok && p.store.items.length === 0
  })())
  ok('② 空串 ⇒ 空成果', parseArtefacts('').ok)
  ok('② 损坏 JSON ⇒ 报错且非「更新版本」', (() => {
    const p = parseArtefacts('{坏')
    return !p.ok && p.newer === false && /损坏/.test(p.reason)
  })())
  ok('② 更高版本 ⇒ 标记 newer（只读，不写回）', (() => {
    const p = parseArtefacts(JSON.stringify({ formatVersion: 99, items: [] }))
    return !p.ok && p.newer === true
  })())
  ok('② 缺 items 数组 ⇒ 报错', !parseArtefacts(JSON.stringify({ formatVersion: 1 })).ok)
  ok('② 单条坏条目跳过、其余保留（不毁整份）', (() => {
    const p = parseArtefacts(JSON.stringify({
      formatVersion: 1,
      items: [rec(), { id: 'bad' }, rec({ id: 'ar_2' })],
    }))
    return p.ok && p.store.items.length === 2
  })())
  ok('② 负向：非法 kind 的条目不算合法记录', (() => {
    const p = parseArtefacts(JSON.stringify({ formatVersion: 1, items: [{ ...rec(), kind: 'x' }] }))
    return p.ok && p.store.items.length === 0
  })())
}

// ---------- ③ 容量 ----------
{
  const small = { maxStoreBytes: 4 * 1024, maxItemBytes: 2 * 1024 }
  const big = rec({ payload: { text: 'x'.repeat(3000) } })
  const r1 = checkArtefactWrite(store([big]), [big], small)
  ok('③ 单条超限 ⇒ 拒绝并说明上限', !r1.ok && /单条成果过大/.test(r1.reason))
  const many = Array.from({ length: 6 }, (_, i) => rec({ id: `ar_${i}`, payload: { text: 'x'.repeat(800) } }))
  const r2 = checkArtefactWrite(store(many), many, small)
  ok('③ 合计超限 ⇒ 拒绝并提示清理', !r2.ok && /超过|上限/.test(r2.reason))
  const okRes = checkArtefactWrite(store([rec()]), [rec()])
  ok('③ 正常体积 ⇒ 通过且报出字节数', okRes.ok && okRes.bytes > 0)
  ok('③ 默认上限与 M0 一致（16 MiB / 256 KiB）',
    ARTEFACT_LIMITS.maxStoreBytes === 16 * 1024 * 1024 && ARTEFACT_LIMITS.maxItemBytes === 256 * 1024)
  ok('③ UTF-8 字节按真实编码算（中文 3 字节）', utf8Bytes('中文') === 6 && utf8Bytes('ab') === 2)
}

// ---------- ④ 过期判定 ----------
{
  const s = store([
    rec({ id: 'a', source: { chapterId: 'ch1', fingerprint: 'fp-1' }, deps: [] }),
    // 来源指向 ch9（不受下面 ch2 的变更影响），依赖里是 ch2 —— 用来单独验证 dep-changed
    rec({ id: 'b', source: { chapterId: 'ch9', fingerprint: 'fp-9' }, deps: [{ kind: 'chapter', id: 'ch2', fingerprint: 'fp-2' }] }),
    rec({ id: 'c', source: { rowId: 'r1', fingerprint: 'fp-r' }, deps: [] }),
  ])
  const r = markStaleByChanges(s, [{ kind: 'chapter', id: 'ch1', fingerprint: 'fp-1-changed' }], 5000)
  ok('④ 来源变了 ⇒ 该条标 source-changed', r.store.items.find(i => i.id === 'a')?.stale?.reason === 'source-changed')
  ok('④ 无关章节变化 ⇒ 其它条不失效', !r.store.items.find(i => i.id === 'b')?.stale)
  ok('④ 返回变了哪些 id', r.changedIds.join('|') === 'a')
  const dep = markStaleByChanges(s, [{ kind: 'chapter', id: 'ch2', fingerprint: 'new' }], 5000)
  ok('④ 依赖变 ⇒ dep-changed（来源没变也算）', dep.store.items.find(i => i.id === 'b')?.stale?.reason === 'dep-changed')
  ok('④ 过期不删除记录', dep.store.items.length === 3)
  const again = markStaleByChanges(r.store, [{ kind: 'chapter', id: 'ch1', fingerprint: 'x' }], 6000)
  ok('④ 已过期的记录不重复标（时间戳保留第一次）', again.store.items.find(i => i.id === 'a')?.stale?.at === 5000)
  const none = markStaleByChanges(s, [], 1)
  ok('④ 空变更 ⇒ 原样返回', none.changedIds.length === 0 && none.store === s)
}

// ---------- ⑤ 导入重映射 ----------
{
  const original = serializeArtefacts(store([
    rec({ id: 'a', source: { chapterId: 'ch1', rowId: 'row1', fingerprint: 'f1' } }),
  ]))
  const maps = new Map([['ch1', 'new-ch1']])
  const rowMaps = new Map([['row1', 'new-row1']])
  const out = remapArtefactsForImport(original, {
    chapters: maps, rows: rowMaps, cards: new Map(), volumes: new Map(),
    makeId: () => 'ar_new', projectId: 'p2', now: 9000,
  })
  const parsed = parseArtefacts(out)
  const it = parsed.ok ? parsed.store.items[0] : null
  ok('⑤ 记录 id 换新（跨项目不复用）', it?.id === 'ar_new')
  ok('⑤ projectId 换成新项目', it?.projectId === 'p2')
  ok('⑤ 章节引用按映射换新', it?.source.chapterId === 'new-ch1')
  ok('⑤ 行引用按映射换新', it?.source.rowId === 'new-row1')
  ok('⑤ 能映射的引用不算悬空（仍 kept）', it?.state === 'kept' && !it?.stale)

  // 悬空：章节不在本次导入里
  const out2 = remapArtefactsForImport(original, {
    chapters: new Map(), rows: new Map(), cards: new Map(), volumes: new Map(),
    makeId: () => 'ar_new2', projectId: 'p3', now: 9000,
  })
  const p2 = parseArtefacts(out2)
  const it2 = p2.ok ? p2.store.items[0] : null
  ok('⑤ 映射不到 ⇒ 标 missing（不静默丢引用）', /^missing:ch1$/.test(it2?.source.chapterId ?? ''))
  ok('⑤ 悬空 ⇒ 降为 draft 并标 version-unknown（可读、不可应用）',
    it2?.state === 'draft' && it2?.stale?.reason === 'version-unknown')

  // 损坏 / 更高版本：原样返回，不静默清空
  ok('⑤ 损坏值原样返回（不覆盖成空成果）', remapArtefactsForImport('{坏', {
    chapters: new Map(), rows: new Map(), cards: new Map(), volumes: new Map(),
    makeId: () => 'x', projectId: 'p', now: 1,
  }) === '{坏')
  const newer = JSON.stringify({ formatVersion: 99, items: [rec()] })
  ok('⑤ 更高版本记录原样返回（旧版本不该改它）', remapArtefactsForImport(newer, {
    chapters: new Map(), rows: new Map(), cards: new Map(), volumes: new Map(),
    makeId: () => 'x', projectId: 'p', now: 1,
  }) === newer)
  ok('⑤ 空项目（无成果）⇒ 仍是空字符串形态，不报错', (() => {
    const p = parseArtefacts(serializeArtefacts(emptyArtefacts()))
    return p.ok && p.store.items.length === 0
  })())
  ok('⑤ 版本常量 = 1（与 M0 §6.3 一致）', ARTEFACT_FORMAT_VERSION === 1)
}

// ---------- ⑥ 接线闸（防回退） ----------
{
  const projects = read('src/lib/db/projects.ts')
  ok('⑥ 导入项目对成果键显式分支', /s\.key === ARTEFACT_SETTING_KEY/.test(projects))
  ok('⑥ 导入时传入四张 id 映射表 + makeId',
    /chapters: map, rows: rowIdMap, cards: cardIdMap, volumes: volMap/.test(projects)
    && /makeId: uid, projectId: newPid, now,/.test(projects))
  const storeSrc = read('src/lib/artefacts/store.ts')
  ok('⑥ 读写层不做 JSON 对象直存（防敏感探测误剥）', /setSettingFor\(projectId, ARTEFACT_SETTING_KEY, check\.text/.test(storeSrc))
  ok('⑥ 读到损坏/更高版本 ⇒ writable:false（禁止覆盖写）', /writable: false/.test(storeSrc))
  const remapSrc = read('src/lib/artefacts/remap.ts')
  ok('⑥ 重映射不依赖 db 层（纯函数可单测）', !/from '@\/lib\/db/.test(remapSrc))
}

// ---------- ⑦ 真实往返：导出 → 导入（mock 存储，验「随包走 + 悬空降级」） ----------
{
  __resetMockStores()
  const pid = (await db.createProject('成果往返')).id
  const payload = serializeArtefacts(store([
    rec({ id: 'keep-no-ref', source: { tabId: 'races', fingerprint: 'f0' }, deps: [] }),
    rec({ id: 'has-ch-ref', source: { chapterId: 'ch-missing', fingerprint: 'f1' }, deps: [] }),
  ]))
  await db.setSettingFor(pid, 'artefacts', payload)
  const bundle = await db.exportProject(pid)
  ok('⑦ 导出包含成果且是字符串（不被敏感探测剥掉）',
    (bundle.settings ?? []).some(s => s.key === 'artefacts' && typeof s.value === 'string'))

  const newPid = await db.importProject(bundle)
  const raw = await db.getSettingFor<unknown>(newPid, 'artefacts', null)
  const parsed = parseArtefacts(raw)
  ok('⑦ 导入后成果仍在（两条都在）', parsed.ok && parsed.store.items.length === 2)
  const items = parsed.ok ? parsed.store.items : []
  const noRef = items.find(i => i.source.fingerprint === 'f0')
  const withRef = items.find(i => i.source.fingerprint === 'f1')
  ok('⑦ 记录 id 全部换新（不再用包里的旧 id）',
    items.every(i => i.id !== 'keep-no-ref' && i.id !== 'has-ch-ref'))
  ok('⑦ projectId 换成新项目', items.every(i => i.projectId === newPid))
  ok('⑦ 无外部引用的成果保持 kept', noRef?.state === 'kept' && !noRef?.stale)
  ok('⑦ 指向不存在章节的成果 ⇒ missing + draft（可读、不可应用）',
    /^missing:ch-missing$/.test(withRef?.source.chapterId ?? '')
    && withRef?.state === 'draft' && withRef?.stale?.reason === 'version-unknown')
}

console.log(`\n———— artefacts：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
