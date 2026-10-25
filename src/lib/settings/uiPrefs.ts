/**
 * 界面偏好持久化 —— 让「折叠过一次，下次还是折叠的」。
 *
 * 项目里有 5 处树状 / 分组折叠：左侧菜单分组、章节总表下的卷列表、表格里的上下级树、
 * 模型设置里的提示词条目、草稿审阅的分组。它们的诉求完全一样 —— **记住用户折叠了什么**。
 * 各写一遍 `useState` + `localStorage` 会有两种腐烂方式：
 *   ① 语义反了（一处存"展开的"、另一处存"折叠的"，读的时候得先在心里翻一次）；
 *   ② 读取不校验类型（存进去是数组、读出来当对象用，静默失效、界面回到默认展开）。
 * 所以收进一个模块，只留一套读写法与一套 hook。
 *
 * 🔴 **一律存「偏离默认的那一侧」**：侧栏存「已折叠的分组」而不是「已展开的分组」。
 *    这样以后新增分组 / 页签时，老用户的存量记录里没有它 → 落到默认值（展开），
 *    而不是「记录里没有它、所以新功能默认是收起的」。这是本模块最要紧的一条约定。
 *
 * 存储媒介是 localStorage：它服务的是「这台机器上这个人的界面习惯」，不进项目数据，
 * 也就不该跟着项目导出 / 云同步走（换台机器重新点一次折叠即可，比把界面偏好混进
 * 项目 JSON 干净得多）。
 *
 * 只读失败（隐私模式 / 配额满 / 脏数据）一律静默退回默认值 —— 界面偏好坏掉不该让页面崩。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

const PREFIX = 'yfe-ui:'

/** 读字符串集合；无记录 / 格式不符 → null（由调用方决定默认值） */
export function readSetPref(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return null
  }
}

export function writeSetPref(key: string, v: Iterable<string>): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify([...v]))
  } catch {
    /* 写不进去就算了：本次会话内的折叠仍然生效，只是不跨会话记忆 */
  }
}

/** 读布尔；无记录 → default */
export function readBoolPref(key: string, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === '1' ? true : raw === '0' ? false : def
  } catch {
    return def
  }
}

export function writeBoolPref(key: string, v: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, v ? '1' : '0')
  } catch {
    /* 同上 */
  }
}

/**
 * 持久化的字符串集合。
 * `defaults` 只在**完全没有记录**时生效；有记录就以记录为准（哪怕是空集合 ——
 * 那代表"用户把所有分组都折叠了"，是个合法状态，不能被默认值覆盖回去）。
 *
 * `key` 变化时（如表格页签从「国家势力」切到「历史事件」）会**重新读一次** ——
 * 每个页签的树折叠状态各记各的，互不串味。用「渲染期间修正 state」的写法而不是
 * effect：effect 会多渲染一帧、期间界面先闪一次旧页签的折叠态。
 */
export function usePersistedSet(
  key: string,
  defaults: readonly string[] = [],
): [Set<string>, (fn: (prev: Set<string>) => Set<string>) => void] {
  const [pair, setPair] = useState<{ key: string; set: Set<string> }>(
    () => ({ key, set: new Set(readSetPref(key) ?? defaults) }),
  )
  if (pair.key !== key) {
    setPair({ key, set: new Set(readSetPref(key) ?? defaults) })
  }
  const update = useCallback((fn: (prev: Set<string>) => Set<string>) => {
    setPair(prev => {
      const next = fn(prev.set)
      writeSetPref(key, next)
      return { key, set: next }
    })
  }, [key])
  return [pair.set, update]
}

/**
 * 持久化的布尔开关（用于"整块展开 / 收起"这类非集合状态）。
 *
 * 🔴 2.6.1 起带**跨实例同步**：写侧派发 `yfe-ui-pref` CustomEvent，其它挂载中的同键 hook
 *   收到后重读 —— 没有它，弹窗里改开关、别的组件（如首页看板娘 / 全局背景层）是不知道的
 *   （2.6.1 R1 实测踩坑：弹窗切看板娘开关、首页立绘纹丝不动）。
 *   ⚠️ 只同步「挂载中的同键 hook」；用 `readBoolPref` 直读的自持 state（如 MascotSettingsDialog
 *   的调用方）仍需回调里手动重读。
 */
export const PREF_EVENT = 'yfe-ui-pref'

export function usePersistedBool(key: string, def: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [pair, setPair] = useState<{ key: string; v: boolean }>(() => ({ key, v: readBoolPref(key, def) }))
  // 🔴 为什么需要这个 ref：update 的依赖只有 [key]，闭包里的 `pair.v` 会是**首帧**的值。
  //    若直接在 update 里读它，函数式更新 `setV(v => !v)` 就会拿到过期值 —— 表现是
  //    「快速连点两次开关，第二次把第一次又翻回去了」。所以用 ref 镜像当前值，渲染期同步维护。
  const latest = useRef(pair.v)
  if (pair.key !== key) {
    const v = readBoolPref(key, def)
    latest.current = v
    setPair({ key, v })
  } else {
    latest.current = pair.v
  }
  useEffect(() => {
    const onPref = (e: Event) => {
      const k = (e as CustomEvent<{ key: string }>).detail?.key
      if (k !== key) return
      const v = readBoolPref(key, def)
      latest.current = v // 别的实例改了同一个键 ⇒ 本实例的「最新值」也要跟上
      setPair({ key, v })
    }
    window.addEventListener(PREF_EVENT, onPref)
    return () => window.removeEventListener(PREF_EVENT, onPref)
  }, [key, def])
  // 🔴 签名必须是 Dispatch<SetStateAction<boolean>>（与 useState 的 setter 完全一致）：
  //    本项目有 5 处写法是 `setX(v => !v)`（NovelEditor / TavernControl / TavernPlot /
  //    TavernPlotScenes / CharacterSheet）。3.0.4 曾把它收窄成 `(v: boolean) => void`，
  //    结果这 5 处全编译不过；当时在调用点改成 `setX(!x)` 绕过 —— 那是**降级修法**，
  //    会把函数式更新退化成闭包读值，重新引入上面说的连点丢更新问题。所以修 hook 本体。
  const update = useCallback<Dispatch<SetStateAction<boolean>>>(v => {
    const next = typeof v === 'function' ? v(latest.current) : v
    latest.current = next
    writeBoolPref(key, next)
    setPair({ key, v: next })
    window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key } }))
  }, [key])
  return [pair.v, update]
}

/** 写一个自由字符串偏好（读取侧一律走带校验的 readEnumPref，别直接 getItem） */
export function writeStringPref(key: string, v: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, v)
    return true
  } catch {
    /* 同 writeBoolPref：写不进去只影响跨会话记忆，不影响本次会话 */
    return false
  }
}

/** 读一个自由字符串偏好（无记录返回 null）。仅用于**不需要枚举校验**的内容 ——
 *  如 2.6.1 的看板娘自定义图（dataURL）与拆书标题示例（自由文本）；有固定取值的一律走 readEnumPref。 */
export function readStringPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

/**
 * 读「枚举字符串」偏好：无记录、或值**不在允许清单内** → fallback。
 *
 * 🔴 为什么一定要校验：存量值可能是旧版本写下的（枚举改过名），用户也可能手改过 localStorage。
 *    这类值一旦被当成合法值喂进业务逻辑（如拿去查缩进单位的实际字符），
 *    拿回来的就是 undefined —— 表现为"按 Tab 没反应"，且极难定位。
 *    偏好不好用不该让功能静默失效，所以非法值一律退回默认。
 */
const volatileEnums = new Map<string, string>()

export function clearEnumSession(key?: string): void {
  if (key === undefined) volatileEnums.clear()
  else volatileEnums.delete(key)
}

export function readEnumPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = volatileEnums.get(key) ?? localStorage.getItem(PREFIX + key)
    return allowed.includes(raw as T) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

/** Failed persistence still retains a validated enum for this application session, across component remounts. */
export function writeEnumPref<T extends string>(key: string, value: T, allowed: readonly T[], fallback: T): T {
  const next = allowed.includes(value) ? value : fallback
  if (writeStringPref(key, next)) volatileEnums.delete(key)
  else volatileEnums.set(key, next)
  return next
}

/** 持久化的枚举字符串偏好（如编辑器的缩进单位）；默认值由调用方给，模块不替它猜 */
export function usePersistedEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [pair, setPair] = useState<{ key: string; v: T }>(() => ({ key, v: readEnumPref(key, allowed, fallback) }))
  if (pair.key !== key) {
    setPair({ key, v: readEnumPref(key, allowed, fallback) })
  }
  useEffect(() => {
    const sync = (e: Event) => {
      let next: T
      if (e.type === 'storage') {
        const storageEvent = e as StorageEvent
        if (storageEvent.key !== PREFIX + key && storageEvent.key !== null) return
        clearEnumSession(key)
        next = readEnumPref(key, allowed, fallback)
      } else {
        const detail = (e as CustomEvent<{ key: string; value?: string }>).detail
        if (detail?.key !== key) return
        // The event value keeps mounted controls in sync even when preferences cannot be persisted.
        next = allowed.includes(detail.value as T) ? detail.value as T : readEnumPref(key, allowed, fallback)
      }
      setPair(prev => prev.key === key && prev.v === next ? prev : { key, v: next })
    }
    window.addEventListener(PREF_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PREF_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [key, allowed, fallback])
  const update = useCallback((v: T) => {
    const next = writeEnumPref(key, v, allowed, fallback)
    setPair({ key, v: next })
    window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key, value: next } }))
  }, [key, allowed, fallback])
  return [pair.v, update]
}

/**
 * 「已折叠集合」→「当前展开的 id 列表」——**纯函数**，供「默认展开」型折叠用。
 *
 * 🔴 存在的理由：酒馆角色卡左栏的折叠态**默认是全展开**，却要持久化作者收起的那些，
 *    于是「展开集合」每次都得由「全集 − 已收起」重新算出来。这个换算若在组件里
 *    手写，将来改一处忘一处就会漂移（表现为"刷新后某个分组凭空冒出来或不见了"）——
 *    收到这里，单测能直接钉住它的边界。
 *
 * 传进来的 `allIds` 顺序被保留（保持故事在左栏的显示顺序）。
 */
export function expandedIdsOf(allIds: readonly string[], collapsed: ReadonlySet<string>): string[] {
  return allIds.filter(id => !collapsed.has(id))
}

/** 与上面成对的逆运算：由「展开集合」与「全集」算出该落盘的「已收起集合」 */
export function collapsedIdsOf(allIds: readonly string[], expanded: readonly string[]): string[] {
  const open = new Set(expanded)
  return allIds.filter(id => !open.has(id))
}
