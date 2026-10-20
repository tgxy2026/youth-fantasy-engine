// ============ A1 本章资料区 · 按有效模板呈现资料 ============
// 2026-10-20 · 方案 §4.1 / A1
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 按有效模板分组展示已绑定字段
//    ② 通过用途突出事件、人物、场景、伏笔和衔接
//    ③ 资料绑定与跳转
//    ④ 缺用途降级

// ============ 资料项类型 ============
export type MaterialKind = 'event' | 'character' | 'scene' | 'foreshadow' | 'connection' | 'other'

// ============ 资料项 ============
export interface ChapterMaterial {
  /** 资料项 ID */
  id: string
  /** 资料类型 */
  kind: MaterialKind
  /** 名称 */
  name: string
  /** 当前值 */
  value: string
  /** 来源（章节/设定项） */
  source: string
  /** 是否绑定 */
  bound: boolean
  /** 用途 */
  purpose?: string
  /** 跳转目标 */
  jumpTarget?: string
}

// ============ 资料分组 ============
export interface MaterialGroup {
  /** 分组名 */
  groupName: string
  /** 资料项 */
  items: ChapterMaterial[]
  /** 是否按用途突出 */
  isProminent: boolean
}

// ============ 按有效模板分组展示 ============
export function groupMaterialsByTemplate(
  materials: ChapterMaterial[],
  templatePurposes: string[],
): MaterialGroup[] {
  const groups: MaterialGroup[] = []
  const groupMap = new Map<string, ChapterMaterial[]>()

  for (const m of materials) {
    const key = m.kind === 'other' ? '其他' : m.kind
    const list = groupMap.get(key) ?? []
    list.push(m)
    groupMap.set(key, list)
  }

  for (const [groupName, items] of groupMap) {
    const isProminent = items.some(i => i.purpose && templatePurposes.includes(i.purpose))
    groups.push({ groupName, items, isProminent })
  }

  return groups
}

// ============ 通过用途突出 ============
export function promoteByPurpose(
  materials: ChapterMaterial[],
  purposePriority: MaterialKind[],
): ChapterMaterial[] {
  return [...materials].sort((a, b) => {
    const pa = purposePriority.indexOf(a.kind)
    const pb = purposePriority.indexOf(b.kind)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })
}

// ============ 资料绑定与跳转 ============
export interface MaterialBinding {
  /** 资料项 ID */
  materialId: string
  /** 是否可跳转 */
  canJump: boolean
  /** 跳转目标 */
  jumpTarget?: string
  /** 跳转原因 */
  jumpReason?: string
}

/** 检查资料项是否可跳转 */
export function checkMaterialJump(material: ChapterMaterial): MaterialBinding {
  if (!material.bound) {
    return {
      materialId: material.id,
      canJump: false,
      jumpReason: '未绑定，无法跳转',
    }
  }
  if (!material.jumpTarget) {
    return {
      materialId: material.id,
      canJump: false,
      jumpReason: '无跳转目标',
    }
  }
  return {
    materialId: material.id,
    canJump: true,
    jumpTarget: material.jumpTarget,
  }
}

// ============ 缺用途降级 ============
export interface FallbackMaterial {
  /** 资料项 */
  material: ChapterMaterial
  /** 降级原因 */
  fallbackReason: string
  /** 是否可用 */
  usable: boolean
}

/** 缺用途时降级处理 */
export function fallbackForMissingPurpose(
  materials: ChapterMaterial[],
  requiredPurposes: string[],
): FallbackMaterial[] {
  return materials.map(m => {
    if (!m.purpose) {
      return {
        material: m,
        fallbackReason: '无用途，按一般资料展示',
        usable: true,
      }
    }
    if (!requiredPurposes.includes(m.purpose)) {
      return {
        material: m,
        fallbackReason: `用途 "${m.purpose}" 不在当前模板范围内`,
        usable: false,
      }
    }
    return {
      material: m,
      fallbackReason: '',
      usable: true,
    }
  })
}

// ============ 正文引用定位 ============
export interface BodyQuote {
  /** 引文内容 */
  quote: string
  /** 段号 */
  paragraphIndex: number
  /** 是否命中 */
  located: boolean
}

/** 在正文中定位引用 */
export function locateBodyQuote(quote: string, bodyText: string): BodyQuote {
  const idx = bodyText.indexOf(quote)
  if (idx < 0) {
    return { quote, paragraphIndex: -1, located: false }
  }
  const before = bodyText.slice(0, idx)
  const paragraphIndex = before.split('\n').length - 1
  return { quote, paragraphIndex, located: true }
}

// ============ 资料区状态 ============
export interface MaterialPanelState {
  /** 当前选中的页签 */
  activeTab: 'outline' | 'materials' | 'quotes'
  /** 是否自动展开 */
  autoExpand: boolean
  /** 是否刷新内容 */
  refreshContent: boolean
  /** 当前章节 ID */
  currentChapterId: string
}

/** 创建资料区状态 */
export function createMaterialPanelState(chapterId: string): MaterialPanelState {
  return {
    activeTab: 'outline',
    autoExpand: false,
    refreshContent: false,
    currentChapterId: chapterId,
  }
}

/** 切换页签 */
export function switchTab(state: MaterialPanelState, tab: MaterialPanelState['activeTab']): MaterialPanelState {
  return { ...state, activeTab: tab }
}

/** 切章只刷新内容，不重置正文光标 */
export function switchChapter(state: MaterialPanelState, chapterId: string): MaterialPanelState {
  return {
    ...state,
    currentChapterId: chapterId,
    refreshContent: true,
  }
}
