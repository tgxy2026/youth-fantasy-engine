/**
 * 字段显示名（Field Aliases）—— 让作者给任意表格字段起自己的名字。
 *
 * 🔴🔴 设计前提（本项目最痛的一条纪律）：**列名即存储键**
 *    表格读写一律走 `cellVal(row, col.name)` / `setCellDraft(row.id, col.name, v)`，
 *    表头 `key` 也是列名 —— 也就是说**改列名 = 换存储键 = 已填数据全部读不到且不报错**。
 *    所以本模块**只替换「给人看的文字」，一个字节的存储键都不碰**：
 *    改名零迁移、已填数据一行不丢、不需要任何数据迁移脚本。
 *
 * 🔴 因此 **AI 链路继续用存储键**（提示词、回填、检索键、去重键一律不变）：
 *    显示名是「作者看的」，AI 看到的仍是稳定的原始字段名，避免回填错键。
 *
 * 存储：项目级 settingsKV，键 `fieldAlias::<tabId>`，值为 `{ [存储键]: 显示名 }`。
 * 不进 `EXCLUDED_META_KEYS` —— 别名要随项目导出 / 云盘同步 / 备份一起走。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSetting, setSetting, getCurrentProjectId } from '@/lib/db'

/** 存储键 → 显示名 */
export type AliasMap = Record<string, string>

/** 显示名最长字数（表头是单行，超长会被 truncate 吃掉） */
export const MAX_ALIAS_LEN = 20

export function aliasKeyOf(tabId: string): string {
  return `fieldAlias::${tabId}`
}

/**
 * 存储键 → **默认显示名**。
 *
 * 🔴🔴 表单 / 卡片页签的存储键是 `模块名::字段名`，界面上只该显示「字段名」那半截。
 *    以前这里直接回退成整个存储键 —— 于是「作品信息 › 基本信息」里每一行都印成
 *    「基本信息::书名」，等于把所属模块的表头在每条前面又重复了一遍
 *    （2026-10-03 社区反馈）。表格页签的键本身就是列名（不含 `::`），原样返回。
 */
export function defaultLabelOf(key: string): string {
  const i = key.lastIndexOf('::')
  return i >= 0 ? key.slice(i + 2) : key
}

/**
 * 清洗别名表：剔掉「本表已不存在的列」（换题材包会改列结构）、空串、
 * 超长、以及与任何**默认显示名** / 已被占用的别名**重名**的条目。
 *
 * 🔴 与 `labelOf` 共用这一份口径 —— 谁也不许自己再判一遍，否则界面各处会不一致。
 */
export function sanitizeAliases(cols: string[], map: AliasMap | null | undefined): AliasMap {
  const out: AliasMap = {}
  if (!map || typeof map !== 'object') return out
  // 默认显示名先全部占位：别名不得与任何一列的显示名相同（否则用户分不清是哪一个）
  const taken = new Set(cols.map(defaultLabelOf))
  for (const key of cols) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue
    const raw = (map[key] ?? '').trim()
    if (!raw) continue // 空 = 用原名
    if (raw === defaultLabelOf(key)) continue // 与默认显示名相同 = 视为未改
    if (raw.length > MAX_ALIAS_LEN) continue
    if (taken.has(raw)) continue // 撞名 → 丢弃（回退原名），绝不显示成两个一样的列
    out[key] = raw
    taken.add(raw)
  }
  return out
}

/** 逐列取显示名：有合法别名用别名，否则回退**默认显示名**（表单键只取 `::` 后的字段名） */
export function labelOf(cols: string[], map: AliasMap | null | undefined, key: string): string {
  return sanitizeAliases(cols, map)[key] ?? defaultLabelOf(key)
}

/** 全表「存储键 → 显示名」映射（表头一次算好，避免逐列重复清洗） */
export function labelMapOf(cols: string[], map: AliasMap | null | undefined): AliasMap {
  const clean = sanitizeAliases(cols, map)
  const out: AliasMap = {}
  for (const k of cols) out[k] = clean[k] ?? defaultLabelOf(k)
  return out
}

/** 有几个字段正被改名（页头按钮上的角标用） */
export function aliasCount(cols: string[], map: AliasMap | null | undefined): number {
  return Object.keys(sanitizeAliases(cols, map)).length
}

/**
 * 校验「正在输入」的别名。返回 `null` 表示合法，否则返回给用户看的原因。
 * 落盘前也走一遍 `sanitizeAliases` 兜底 —— 前端校验只是提示层，不是唯一防线。
 */
export function validateAliasInput(
  cols: string[],
  map: AliasMap | null | undefined,
  key: string,
  input: string,
): string | null {
  const raw = input.trim()
  if (!raw) return null // 空 = 恢复默认，合法
  if (raw.length > MAX_ALIAS_LEN) return `最多 ${MAX_ALIAS_LEN} 个字`
  if (raw === defaultLabelOf(key)) return null
  const clean = sanitizeAliases(cols, map)
  for (const other of cols) {
    if (other === key) continue
    const shown = clean[other] ?? defaultLabelOf(other)
    if (shown === raw) return `与「${shown}」重名了`
  }
  return null
}

/* ────────────────────────── 跨组件共享（表头 / 关系分组 / 设定检索同表共用一份） ────────────────────────── */

/**
 * 别名缓存：按页签存，但**每条都带项目 id**。
 *
 * 🔴 为什么必须带 pid：真实存储键是 `${pid}::fieldAlias::<tabId>`（项目级，随项目导出 / 同步 / 备份走），
 *    而 cache 的键只有 `tabId` —— 换项目时 tabId 不变，只按 tabId 命中就会把**上一个项目的显示名**
 *    端给新项目（在 A 书把《种族生物》某列改成「契约」，切到 B 书那列也跟着叫「契约」）。
 *    所以取用前先比 pid，不一致即当未命中重读 —— 与 `styleFingerprint` 同一手法，
 *    不再依赖「有人记得在切项目时调 `invalidateAliasCache`」（此前该函数全仓无人调用）。
 */
const cache = new Map<string, { pid: string; map: AliasMap }>()
const subs = new Set<() => void>()

function emit(): void {
  subs.forEach(fn => fn())
}

/** 读缓存（pid 不符视为未命中）。**绝不返回别的项目的别名**。 */
function peekAliases(tabId: string, pid: string): AliasMap | undefined {
  const hit = cache.get(tabId)
  return hit && hit.pid === pid ? hit.map : undefined
}

/** 清缓存：换项目 / 数据整体导入后的**显式失效**入口（pid 比对已能兜底，这里是双保险） */
export function invalidateAliasCache(tabId?: string): void {
  if (tabId) cache.delete(tabId)
  else cache.clear()
  emit()
}

export async function loadAliases(tabId: string): Promise<AliasMap> {
  const pid = getCurrentProjectId()
  const hit = peekAliases(tabId, pid)
  if (hit) return hit
  let raw: AliasMap = {}
  try {
    const v = await getSetting<AliasMap>(aliasKeyOf(tabId), {})
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v
  } catch {
    raw = {} // 读失败按「无别名」处理：显示层退回原名，功能不可用但不影响数据
  }
  cache.set(tabId, { pid, map: raw })
  return raw
}

/** 落盘前统一清洗；同表其它面板（关系分组 / 设定检索）会立刻跟着刷新 */
export async function saveAliases(tabId: string, cols: string[], map: AliasMap): Promise<AliasMap> {
  const clean = sanitizeAliases(cols, map)
  cache.set(tabId, { pid: getCurrentProjectId(), map: clean })
  emit()
  await setSetting(aliasKeyOf(tabId), clean)
  return clean
}

/**
 * 订阅**任意表**的别名变化，返回一个自增版本号。
 *
 * 🔴 用途：一个组件要同时看**多张表**的别名时（设定检索就是），`useFieldAliases(tabId, cols)`
 *    只能盯一张表 —— 逐个 tabId 调 hook 既违反 hooks 规则、也没法动态增删。
 *    本 hook 只提供「有人改了别名」这一个信号，组件据此重读自己需要的那几张表。
 */
export function useAliasRevision(): number {
  const [rev, setRev] = useState(0)
  useEffect(() => {
    const onChange = () => setRev(r => r + 1)
    subs.add(onChange)
    return () => {
      subs.delete(onChange)
    }
  }, [])
  return rev
}

/**
 * 组件侧入口。`cols` 传本表的**存储键数组**（顺序即列顺序）。
 * 返回 `labels`（键 → 显示名）与 `save`（保存整张映射）。
 */
export function useFieldAliases(tabId: string, cols: string[]) {
  const [map, setMap] = useState<AliasMap>(() => peekAliases(tabId, getCurrentProjectId()) ?? {})
  const colsRef = useRef(cols)
  colsRef.current = cols
  // ⚠️ 分隔符用「转义写法」而不是字面 NUL：等价的运行时值，但**源码里不再有控制字符** ——
  //    否则 grep / ripgrep 会把整个文件判成 binary，只报文件名不报行号（本项目扫描器会静默失明）。
  const colsKey = cols.join('\u0000')

  const reload = useCallback(async () => {
    const m = await loadAliases(tabId)
    setMap(m)
  }, [tabId])

  useEffect(() => {
    let alive = true
    const hit = peekAliases(tabId, getCurrentProjectId())
    if (!hit) {
      void loadAliases(tabId).then(m => {
        if (alive) setMap(m)
      })
    } else {
      setMap(hit)
    }
    // 别的面板改了别名 → 跟着刷新；pid 对不上（换了项目）→ 重读，绝不沿用上一本书的名字
    const onChange = () => {
      const cur = peekAliases(tabId, getCurrentProjectId())
      if (cur) setMap(cur)
      else void loadAliases(tabId).then(m => { if (alive) setMap(m) })
    }
    subs.add(onChange)
    return () => {
      alive = false
      subs.delete(onChange)
    }
  }, [tabId])

  const labels = useMemo(
    () => labelMapOf(colsRef.current, map),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colsKey, map],
  )

  const save = useCallback(
    async (next: AliasMap) => {
      const clean = await saveAliases(tabId, colsRef.current, next)
      setMap(clean)
    },
    [tabId],
  )

  return { map, labels, reload, save }
}
