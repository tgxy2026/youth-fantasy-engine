/**
 * 作者成果记录 · 纯逻辑层（3.6.0 · A1）
 *
 * 依据：`docs/归档/3.6/3.6.0-M0-数据与执行台账现状盘点-2026-11-17.md` 第 6 节。
 * 本文件**不碰存储**：解析、容量判定、过期判定、导入重映射全在这里，便于穷举单测。
 *
 * 🔴🔴 为什么值要**序列化成字符串**再存（而不是直接放对象）：
 *    `exportProject()` 收集项目包时会调 `isSensitiveSettingKey(key, value)`，
 *    其中 `valueHasSecretField()` 会**递归检查值的所有键名**，命中 `token` / `password` /
 *    `secret` / `apiKey` 之类就把这条设置整条剥掉（安全红线：宁可多剥，不能漏密钥）。
 *    成果的 `payload` 是各工作包自定义结构（分析卡里出现一个叫 `token` 的字段完全可能），
 *    一旦被误判，作者会看到「导出成功、成果却没了」，且无从排查。
 *
 *    ⇒ 存成**字符串**：值探测只看顶层，字符串不是对象，直接放行；密钥扫描对项目包其余
 *      设置照旧生效，安全判据一个字没改。
 *
 *    代价：读的时候要 JSON.parse（损坏已有降级路径，见 `parseArtefacts`）。
 *    ⚠️ 后来者不要“顺手”把它改回对象 —— 那会让成果在导出时静默消失。
 */
import type {
  ArtefactDep, ArtefactRecord, ArtefactStore, ArtefactStale, ArtefactState,
} from './types'

/** `settingsKV` 里的键（不含 `<pid>::` 前缀，由 `getSettingFor`/`setSettingFor` 加） */
export const ARTEFACT_SETTING_KEY = 'artefacts'

/** 记录结构版本：与 `ProjectBundle.version`（当前 3）**独立**，理由见 M0 §6.3 */
export const ARTEFACT_FORMAT_VERSION = 1

/** 容量上限（M0 §6.2）：项目 16 MiB、单条 256 KiB（序列化后的 UTF-8 字节） */
export const ARTEFACT_LIMITS = {
  maxStoreBytes: 16 * 1024 * 1024,
  maxItemBytes: 256 * 1024,
} as const

export function emptyArtefacts(): ArtefactStore {
  return { formatVersion: ARTEFACT_FORMAT_VERSION, items: [] }
}

/** UTF-8 字节数（配额按真实字节算，不按字符数） */
export function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  // 兜底：按码点估算（代理对 4 字节，其余按 1–3 字节）
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

export type ArtefactParseResult =
  | { ok: true; store: ArtefactStore }
  | { ok: false; reason: string; /** 更高版本：只读展示，禁止写回 */ newer: boolean }

const KINDS = new Set(['analysis', 'reference', 'review', 'candidate'])
const STATES = new Set(['draft', 'kept', 'excluded'])

function isRecord(v: unknown): v is ArtefactRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return false
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return false
  if (typeof r.projectId !== 'string') return false
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return false
  if (!r.source || typeof r.source !== 'object') return false
  if (typeof (r.source as Record<string, unknown>).fingerprint !== 'string') return false
  if (r.deps !== undefined && !Array.isArray(r.deps)) return false
  return true
}

/**
 * 解析一条 `settingsKV` 值。
 *
 * 三种失败必须分开（与 `loadAtlasSchema` 同口径）：
 *  · 空 / 缺失 ⇒ 空成果（**不是错误**，新项目本来就没有）；
 *  · 更高 `formatVersion` ⇒ 只读，禁止写回（写回会丢新版本字段）；
 *  · 结构损坏 ⇒ 报错，调用方必须**保留原值不覆盖**。
 */
export function parseArtefacts(raw: unknown): ArtefactParseResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, store: emptyArtefacts() }
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { ok: false, reason: '成果记录的 JSON 已损坏', newer: false }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: '成果记录的结构不合法（不是对象）', newer: false }
  }
  const o = value as Record<string, unknown>
  const ver = typeof o.formatVersion === 'number' ? o.formatVersion : 0
  if (ver > ARTEFACT_FORMAT_VERSION) {
    return { ok: false, reason: `成果记录来自更新版本（formatVersion ${ver}）`, newer: true }
  }
  if (!Array.isArray(o.items)) return { ok: false, reason: '成果数据格式不完整（缺少条目列表）', newer: false }
  const items: ArtefactRecord[] = []
  for (const it of o.items) {
    // 单条损坏不毁整份：跳过坏条目并在下面用数量提示（调用方决定是否告知作者）
    if (!isRecord(it)) continue
    items.push(it)
  }
  return { ok: true, store: { formatVersion: ARTEFACT_FORMAT_VERSION, items } }
}

/** 序列化（字符串形态的理由见文件头） */
export function serializeArtefacts(store: ArtefactStore): string {
  return JSON.stringify({ formatVersion: ARTEFACT_FORMAT_VERSION, items: store.items })
}

export type ArtefactWriteCheck =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: string }

/**
 * 写入前的容量检查（M0 §6.2：超限**拒绝并提示**，不静默淘汰作者保存的东西）。
 * @param incoming 本次要新增/替换的条目（用于单条上限与"超出多少"的说明）
 */
export function checkArtefactWrite(
  store: ArtefactStore, incoming?: readonly ArtefactRecord[],
  limits: { maxStoreBytes: number; maxItemBytes: number } = ARTEFACT_LIMITS,
): ArtefactWriteCheck {
  for (const it of incoming ?? []) {
    const bytes = utf8Bytes(JSON.stringify(it))
    if (bytes > limits.maxItemBytes) {
      return {
        ok: false,
        reason: `单条成果过大（${Math.round(bytes / 1024)} KiB，上限 ${Math.round(limits.maxItemBytes / 1024)} KiB）：请缩短内容或拆成多条`,
      }
    }
  }
  const text = serializeArtefacts(store)
  const bytes = utf8Bytes(text)
  if (bytes > limits.maxStoreBytes) {
    return {
      ok: false,
      reason: `项目成果合计 ${(bytes / 1024 / 1024).toFixed(1)} MiB，超过 ${(limits.maxStoreBytes / 1024 / 1024).toFixed(0)} MiB 上限：请先清理不再需要的成果`,
    }
  }
  return { ok: true, text, bytes }
}

/** 变更信号：哪些来源/依赖变了 */
export interface ArtefactChange {
  kind: 'chapter' | 'setting' | 'outline' | 'reference' | 'row' | 'card'
  id: string
  fingerprint: string
}

/**
 * 按「实际读取的依赖」标过期（M0 §15.2：只比本次实际用到的，不因无关编辑全部失效）。
 *
 * 🔴 过期 ≠ 删除：记录保留、可读，但**禁止直接应用**（F 包候选尤其）。
 * @param now 注入时间，便于测试
 */
export function markStaleByChanges(
  store: ArtefactStore, changes: readonly ArtefactChange[], now: number,
): { store: ArtefactStore; changedIds: string[] } {
  if (!changes.length) return { store, changedIds: [] }
  const byKey = new Map<string, string>()
  for (const c of changes) byKey.set(`${c.kind}:${c.id}`, c.fingerprint)
  const changedIds: string[] = []
  const items = store.items.map(it => {
    if (it.stale) return it
    const sourceHit = sourceKeyOf(it.source)
    const sourceFp = sourceHit ? byKey.get(sourceHit) : undefined
    const depHit = (it.deps ?? []).some(d => {
      const fp = byKey.get(`${depKeyOf(d.kind)}:${d.id}`)
      return fp !== undefined && fp !== d.fingerprint
    })
    const reason: ArtefactStale['reason'] | null =
      sourceFp !== undefined && sourceFp !== it.source.fingerprint ? 'source-changed'
        : depHit ? 'dep-changed' : null
    if (!reason) return it
    changedIds.push(it.id)
    return { ...it, stale: { at: now, reason } }
  })
  return { store: { ...store, items }, changedIds }
}

function sourceKeyOf(s: ArtefactRecord['source']): string | null {
  if (s.chapterId) return `chapter:${s.chapterId}`
  if (s.rowId) return `row:${s.rowId}`
  if (s.cardId) return `card:${s.cardId}`
  return null
}

function depKeyOf(kind: ArtefactDep['kind']): string {
  return kind === 'setting' ? 'row' : kind === 'anchor' ? 'outline' : kind
}

/** 导入重映射所需的 id 映射表（旧 id → 新 id） */
export interface ArtefactRemapContext {
  chapters?: ReadonlyMap<string, string>
  rows?: ReadonlyMap<string, string>
  cards?: ReadonlyMap<string, string>
  volumes?: ReadonlyMap<string, string>
  /** 新 id 生成器（注入，避免本文件依赖 db） */
  makeId: () => string
  projectId: string
  now: number
}

const MISSING = (id: string) => (id.startsWith('missing:') ? id : `missing:${id}`)

/**
 * 导入项目时的成果重映射（M0 §6.4）。
 *
 * 🔴 为什么必须显式处理：`remapSettingValue()` 只认 4 类已知键（白名单），
 *    不认识 `artefacts` ⇒ 原样搬运 ⇒ 记录里的 chapterId / rowId 全指向**旧项目**的 id，
 *    表现为「导入后成果还在，但点开定位全错」，且没有任何报错。
 *
 * 规则：
 *  · 记录 id 一律换新（跨项目 id 不得复用）；
 *  · 来源/依赖能映射就换，映射不到标 `missing:`；
 *  · 一旦有悬空引用 ⇒ 该条降为 `draft` 并标 `version-unknown`（可读、不可应用）。
 */
export function remapArtefactsForImport(raw: unknown, ctx: ArtefactRemapContext): unknown {
  const parsed = parseArtefacts(raw)
  // 读不懂就原样留着（不静默清空）；新版本记录也原样（旧客户端不该改它）
  if (!parsed.ok) return raw
  const mapOf = (kind: ArtefactDep['kind'] | 'row' | 'card'): ReadonlyMap<string, string> | undefined => {
    if (kind === 'chapter') return ctx.chapters
    if (kind === 'row' || kind === 'setting') return ctx.rows
    if (kind === 'card') return ctx.cards
    return undefined
  }
  const items = parsed.store.items.map<ArtefactRecord>(it => {
    let dangling = false
    const mapId = (kind: 'chapter' | 'row' | 'card', id?: string): string | undefined => {
      if (!id) return id
      const map = mapOf(kind)
      const next = map?.get(id)
      if (!next) { dangling = true; return MISSING(id) }
      return next
    }
    const source = { ...it.source }
    if (source.chapterId) source.chapterId = mapId('chapter', source.chapterId)
    if (source.rowId) source.rowId = mapId('row', source.rowId)
    if (source.cardId) source.cardId = mapId('card', source.cardId)
    if (source.tabId && source.tabId.startsWith('chapter-vol-') && ctx.volumes) {
      const oldVol = source.tabId.slice('chapter-vol-'.length)
      const nextVol = ctx.volumes.get(oldVol)
      source.tabId = nextVol ? `chapter-vol-${nextVol}` : `chapter-vol-${MISSING(oldVol)}`
      if (!nextVol) dangling = true
    }
    const deps = (it.deps ?? []).map(d => {
      if (d.kind === 'chapter') return { ...d, id: mapId('chapter', d.id) ?? d.id }
      if (d.kind === 'setting') return { ...d, id: mapId('row', d.id) ?? d.id }
      if (d.kind === 'reference') return d   // 参考资料是独立库，id 不变（缺失时由调用方标不可用）
      return d
    })
    return {
      ...it,
      id: ctx.makeId(),
      projectId: ctx.projectId,
      source,
      deps,
      createdAt: it.createdAt || ctx.now,
      updatedAt: ctx.now,
      ...(dangling
        ? { state: 'draft' as ArtefactState, stale: { at: ctx.now, reason: 'version-unknown' as const } }
        : {}),
    }
  })
  // 以**字符串**写回（理由见文件头）
  return serializeArtefacts({ formatVersion: ARTEFACT_FORMAT_VERSION, items })
}
