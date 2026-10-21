// ============ A1 本章资料区 · 按有效模板呈现资料 ============
// 2026-10-20 · 方案 §4.1 / A1
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 按有效模板分组展示已绑定字段
//    ② 通过用途突出事件、人物、场景、伏笔和衔接
//    ③ 资料绑定与跳转
//    ④ 缺用途降级

import type { RecordRef } from '@/lib/revision/revisionTypes'

/** 项目设置里的章节绑定；只保存稳定 ID，不复制细纲或设定正文。 */
export interface ChapterContextBinding {
  schema: 1
  outlineId?: string
  pinnedRefs: RecordRef[]
  updatedAt: number
}

export function emptyChapterContextBinding(): ChapterContextBinding {
  return { schema: 1, pinnedRefs: [], updatedAt: Date.now() }
}

/** 容忍旧值/损坏值；过滤跨项目引用和不完整 ID，避免切项目后串资料。 */
export function normalizeChapterContextBinding(
  raw: unknown,
  projectId: string,
): ChapterContextBinding {
  const value = raw && typeof raw === 'object' ? raw as Partial<ChapterContextBinding> : {}
  const refs = Array.isArray(value.pinnedRefs) ? value.pinnedRefs.filter((ref): ref is RecordRef => {
    if (!ref || typeof ref !== 'object') return false
    const candidate = ref as Partial<RecordRef>
    return ['chapter', 'outline', 'card', 'row', 'form', 'sub'].includes(String(candidate.kind))
      && candidate.projectId === projectId
      && typeof candidate.tabId === 'string' && candidate.tabId.length > 0
      && typeof candidate.id === 'string' && candidate.id.length > 0
  }) : []
  const unique = new Map(refs.map(ref => [`${ref.kind}|${ref.tabId}|${ref.id}`, ref]))
  return {
    schema: 1,
    ...(typeof value.outlineId === 'string' && value.outlineId ? { outlineId: value.outlineId } : {}),
    pinnedRefs: [...unique.values()],
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

/** 稳定引用的身份键；名称变化不影响固定关系。 */
export function chapterContextRefKey(ref: RecordRef): string {
  return `${ref.kind}|${ref.tabId}|${ref.id}`
}

export type OutlinePurpose = '事件' | '人物' | '场景' | '伏笔' | '衔接'

/**
 * 用当前有效字段的稳定键、名称和说明识别细纲用途。
 * 场景按字段元数据识别，因此新增场景槽无需改代码；未知字段仍照常展示。
 */
export function outlinePurposeForField(field: {
  id: string
  sourceKey: string
  label: string
  defaultLabel?: string
  description?: string
}): OutlinePurpose | undefined {
  const text = [field.id, field.sourceKey, field.label, field.defaultLabel, field.description]
    .filter(Boolean).join(' ').toLocaleLowerCase()
  if (/(伏笔|foreshadow)/i.test(text)) return '伏笔'
  if (/(场景|scene)/i.test(text)) return '场景'
  if (/(出场人物|人物|角色|character)/i.test(text)) return '人物'
  if (/(承接|衔接|过渡|下章预告|continuity|transition)/i.test(text)) return '衔接'
  if (/(一句话事件|核心事件|剧情事件|事件概要|event)/i.test(text)) return '事件'
  return undefined
}

export interface OutlineReferenceField {
  id: string
  sourceKey: string
  label: string
  defaultLabel?: string
  description?: string
  value: string
}

export interface OutlineReferenceItem {
  ref: RecordRef
  name: string
  source: string
  matchTerms: string[]
}

export interface OutlineReferenceSuggestion {
  fieldKey: string
  fieldLabel: string
  purpose?: OutlinePurpose
  term: string
  candidates: Pick<OutlineReferenceItem, 'ref' | 'name' | 'source'>[]
}

/** 只提出名称/编号的字面匹配；重复匹配保留所有候选，由作者选中后才固定。 */
export function findOutlineReferenceSuggestions(
  fields: readonly OutlineReferenceField[],
  records: readonly OutlineReferenceItem[],
): OutlineReferenceSuggestion[] {
  const suggestions = new Map<string, OutlineReferenceSuggestion>()
  for (const field of fields) {
    const value = field.value.toLocaleLowerCase()
    if (!value) continue
    for (const record of records) {
      const term = [...new Set(record.matchTerms.map(item => item.trim()).filter(item => item.length >= 2))]
        .sort((a, b) => b.length - a.length)
        .find(item => value.includes(item.toLocaleLowerCase()))
      if (!term) continue
      const key = `${field.sourceKey}\u0000${term.toLocaleLowerCase()}`
      const purpose = outlinePurposeForField(field)
      const suggestion = suggestions.get(key) ?? {
        fieldKey: field.sourceKey,
        fieldLabel: field.label,
        ...(purpose ? { purpose } : {}),
        term,
        candidates: [],
      }
      if (!suggestion.candidates.some(item => chapterContextRefKey(item.ref) === chapterContextRefKey(record.ref))) {
        suggestion.candidates.push({ ref: record.ref, name: record.name, source: record.source })
      }
      suggestions.set(key, suggestion)
    }
  }
  return [...suggestions.values()]
}

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
