/**
 * 字段显示名（Field Aliases）—— 让作者给任意表格字段起自己的名字。
 *
 * 🔴🔴 设计前提（本项目最痛的一条纪律）：**列名即存储键**
 *    表格读写一律走 `cellVal(row, col.name)` / `setCellDraft(row.id, col.name, v)`，
 *    表头 `key` 也是列名 —— 也就是说**改列名 = 换存储键 = 已填数据全部读不到且不报错**。
 *    所以本模块**只替换「给人看的文字」，一个字节的存储键都不碰**：
 *    改名零迁移、已填数据一行不丢、不需要任何数据迁移脚本。
 *
 * 🔴 存储键**永不改变**（提示词里的值、回填、检索键、去重键一律仍按存储键）：
 *    显示名只是「模型看到的名字」。3.2.0 · T3 起，改名会随有效模板的 `label`
 *    进入 AI 上下文（见 `templates/labels.ts`）—— 作者把「世界名称」叫成「世界称呼」，
 *    模型就该按「世界称呼」理解；但写入仍落到 `模块::世界名称`，一个字节都不动。
 *
 * 存储：项目级 settingsKV，键 `fieldAlias::<tabId>`，值为 `{ [存储键]: 显示名 }`。
 * 不进 `EXCLUDED_META_KEYS` —— 别名要随项目导出 / 云盘同步 / 备份一起走。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSetting, setSetting, getCurrentProjectId } from '@/lib/db'
import { aliasKeyOf, labelMapOf, sanitizeAliases, type AliasMap } from './aliasCore'

// 纯函数核心在 `aliasCore.ts`（模板解析层也要用，那一层不能依赖 React）。
// 这里原样再导出，既有 import 路径保持不变。
export {
  MAX_ALIAS_LEN, aliasKeyOf, defaultLabelOf, sanitizeAliases, labelOf, labelMapOf, aliasCount, validateAliasInput,
} from './aliasCore'
export type { AliasMap } from './aliasCore'

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
