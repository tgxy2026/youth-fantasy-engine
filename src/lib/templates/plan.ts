/**
 * 3.2.0 · WT1-3：模板变更计划（`planTemplateChange`）——**只读**推演
 *
 * 方案 §3.6 + §17.2：作者改完模板、点「确认更换」之前，必须先拿到一份
 * **能看懂的变更计划**：哪些字段保留、哪些新增、哪些归档、旧值怎么办、
 * 哪些引用会失效、AI 能力有什么变化。本文件只负责「推演」，不写任何数据 ——
 * 执行在 `migrate.ts`（WT1-4），两边严格分开：
 *   · 计划错了只会显示错，不会改坏数据；
 *   · 执行层拿到的输入必须是一份已确认的计划，不能现场再推一遍。
 *
 * 🔴 三条铁律（全部来自方案原文）：
 *   1. **默认归档，不删除旧值**；删除/合并/类型转换必须有预览（§3.6）。
 *   2. **不能因字段显示名称相同就绑定到另一字段**（§3.4 第 103 行）——
 *      同名只产生「建议」，必须作者显式确认才成立。
 *   3. **同 ID 字段改义后，旧值不能按新语义读取**（§3.6 第 207 行）——
 *      哪怕没有未知键，也要标「旧代次待整理」，不能悄悄当新值用。
 *
 * 🔴 纯函数：不读库、不碰全局状态、不产生副作用。值规模由调用方经
 *    `valueCounts` 传入；计划本身只对结构负责。
 */
import type { EffectiveField, TemplateFieldPermissions, TemplateFieldType } from './types'
import type { TemplateDef } from './definition'

// ────────────────────────── 计划结构 ──────────────────────────

/** 字段在本次变更中的处置 */
export type FieldDisposition =
  | 'kept'           // 同 ID 保留，定义一字未动（布局变化不算）
  | 'kept-modified'  // 同 ID 保留，定义有变（标签/类型/选项/权限/适用范围…）
  | 'added'          // 新模板新增，历史上没有这个字段
  | 'archived'       // 旧字段在新模板中不存在 ⇒ 归档（值留着，不显示）
  | 'suggested-map'  // 显示名与某个新字段相同 ⇒ **仅建议**，待作者确认

/** 旧值的处置意图（执行层据此写值，计划只做判定） */
export type ValuePlan =
  | 'keep'          // 值原样有效（定义未变，或只变布局/分组）
  | 'stale-flag'    // 同 ID 但含义变了 ⇒ 值保留 + 标「旧代次待整理」（§17.2-8）
  | 'convert'       // 类型转换，计划已判定可行（可能仍需逐值校验）
  | 'manual'        // 必须作者逐条处理，不许自动写
  | 'archive-keep'  // 字段归档 ⇒ 值原地不动，只是常规使用时不出现

/** 单字段的定义变化明细 */
export interface FieldChange {
  aspect:
    | 'label' | 'type' | 'options' | 'permissions'
    | 'appliesTo' | 'unit' | 'description' | 'group' | 'archived'
    | 'fixedOptions'
  /** 变化前的可读描述 */
  from: string
  /** 变化后的可读描述 */
  to: string
}

export interface FieldPlanItem {
  /** 旧字段 ID（added 时为空） */
  fromId?: string
  /** 新字段 ID（archived 时为空） */
  toId?: string
  disposition: FieldDisposition
  /** 变化明细（kept 恒为空数组） */
  changes: FieldChange[]
  /** 值处置意图 */
  valuePlan: ValuePlan
  /**
   * 显示名相同的候选目标（仅 `suggested-map` 有值）。
   * 🔴 这是**建议**，不是绑定：作者不确认，执行层就不许把旧值搬过去。
   */
  suggestedTargetId?: string
  /** 给人看的一句话说明（界面直接展示） */
  note?: string
}

/** 阻断项：不解决就不能执行迁移 */
export type PlanBlockerCode =
  | 'name-field-missing'    // 新模板绑不到有效名称字段（表格标题会丢）
  | 'duplicate-field-id'    // 新模板字段 ID 重复
  | 'group-missing'         // 字段引用了新模板里不存在的分组
  | 'unknown-type'          // 新模板含无法识别的字段类型
  | 'same-label-ambiguous'  // 同一显示名对应多个字段，连建议都给不出

/** 提示项：不阻断执行，但必须让作者知情 */
export type PlanWarningCode =
  | 'same-label-suggestion'  // 存在同名不同 ID 的字段，待作者定夺
  | 'ai-write-tightened'     // 某字段不再允许 AI 填写（旧授权被收紧）
  | 'ai-write-opened'        // 某字段新开放 AI 填写
  | 'ai-read-tightened'      // 某字段不再允许 AI 参考（已存值不再进上下文）
  | 'value-needs-conversion' // 有字段需要类型转换（可能逐值校验）
  | 'options-shrunk'         // 选项变少 ⇒ 已有值可能不在选项内
  | 'type-changed'           // 字段类型变化 ⇒ 旧值按旧代次待整理
  | 'capability-tightened'   // 能力收紧：封闭枚举 / 展示 / 检索权限（隐藏 ≠ 归档，另判）
  | 'semantic-digest-changed'// 语义摘要变化 ⇒ 索引/AI 候选按规则失效

export interface PlanBlocker {
  code: PlanBlockerCode
  detail: string
  fieldId?: string
}

export interface PlanWarning {
  code: PlanWarningCode
  detail: string
  fieldId?: string
}

export interface TemplateChangePlan {
  tabId: string
  /** 旧模板 ID；`from=null`（尚未采用模板）时为 `'<none>'` */
  fromTemplateId: string
  toTemplateId: string
  items: FieldPlanItem[]
  summary: {
    kept: number
    modified: number
    added: number
    archived: number
    suggestedMaps: number
    /** 值需要人工处理的字段数（manual + convert） */
    needsManual: number
  }
  blockers: PlanBlocker[]
  warnings: PlanWarning[]
  /** 语义摘要是否变化（决定索引 / AI 候选是否失效） */
  semanticChanged: boolean
  /** 新模板的名称字段是否有效 */
  nameFieldValid: boolean
  /**
   * 受影响（可能有旧值）的字段数 —— 需要 `valueCounts` 才算得出；
   * 没传时为 0，界面应显示「规模未知」而不是「没有影响」。
   */
  affectedFieldCount: number
  /** 受影响字段上的条目总数（同样依赖 `valueCounts`） */
  affectedValueCount: number
  /** 是否传了 `valueCounts`（界面据此区分「无影响」与「不知道」） */
  valueScaleKnown: boolean
}

export interface PlanOptions {
  /**
   * 各字段当前有条目的数量：`{ [fieldId]: count }`。
   * 🔴 只用于统计规模，**不参与判定** —— 没有它计划照样完整，
   *    只是说不出「会影响多少条资料」。
   */
  valueCounts?: Record<string, number>
}

// ────────────────────────── 比较工具 ──────────────────────────

function permsOf(f: EffectiveField): TemplateFieldPermissions {
  return f.permissions
}

function optionsOf(f: EffectiveField): string[] {
  return f.options ?? []
}

function appliesToOf(f: EffectiveField): string {
  return f.appliesTo === '*' ? '*' : [...f.appliesTo].sort().join(',')
}

/** 布局性变化：不影响语义，只影响「看起来在哪」 */
const LAYOUT_ASPECTS = new Set(['group'])

/**
 * 逐字段比较定义，产出变化明细。
 * 🔴 只认**语义相关**的 aspect：标签、类型、选项、权限、适用范围、单位、说明、
 *    归档态、分组。分组是布局，算变化但不致使旧值失效。
 */
export function diffField(from: EffectiveField, to: EffectiveField): FieldChange[] {
  const out: FieldChange[] = []
  if (from.label !== to.label) {
    out.push({ aspect: 'label', from: from.label, to: to.label })
  }
  if (from.type !== to.type) {
    out.push({ aspect: 'type', from: from.type, to: to.type })
  }
  const fo = optionsOf(from)
  const to_ = optionsOf(to)
  if (fo.length !== to_.length || fo.some((o, i) => o !== to_[i])) {
    out.push({ aspect: 'options', from: fo.join(' / ') || '（无）', to: to_.join(' / ') || '（无）' })
  }
  const fp = permsOf(from)
  const tp = permsOf(to)
  const permKeys: (keyof TemplateFieldPermissions)[] = ['table', 'detail', 'search', 'aiRead', 'aiWrite']
  for (const k of permKeys) {
    if (fp[k] !== tp[k]) {
      out.push({ aspect: 'permissions', from: `${k}=${fp[k]}`, to: `${k}=${tp[k]}` })
    }
  }
  if (appliesToOf(from) !== appliesToOf(to)) {
    out.push({ aspect: 'appliesTo', from: appliesToOf(from), to: appliesToOf(to) })
  }
  if ((from.unit ?? '') !== (to.unit ?? '')) {
    out.push({ aspect: 'unit', from: from.unit ?? '（无）', to: to.unit ?? '（无）' })
  }
  if ((from.description ?? '') !== (to.description ?? '')) {
    out.push({ aspect: 'description', from: from.description ?? '（无）', to: to.description ?? '（无）' })
  }
  if (from.archived !== to.archived) {
    out.push({ aspect: 'archived', from: String(from.archived), to: String(to.archived) })
  }
  // 🔴 封闭枚举变化必须入明细：它直接决定「作者还能不能加选项」，
  //    是语义能力的变化，不是外观。
  if (Boolean(from.fixedOptions) !== Boolean(to.fixedOptions)) {
    out.push({
      aspect: 'fixedOptions',
      from: from.fixedOptions ? '封闭枚举' : '可增改',
      to: to.fixedOptions ? '封闭枚举' : '可增改',
    })
  }
  if (from.groupId !== to.groupId) {
    out.push({ aspect: 'group', from: from.groupId, to: to.groupId })
  }
  return out
}

/** 变化是否只是布局（分组）——布局变化不使旧值失效 */
export function isLayoutOnlyChange(changes: readonly FieldChange[]): boolean {
  return changes.length > 0 && changes.every(c => LAYOUT_ASPECTS.has(c.aspect))
}

/**
 * 类型转换判定：旧值能不能带着走。
 *
 * 🔴 逐条对齐方案 §17.3「统一值编解码」：沿用 `Record<string,string>` 与
 *    图鉴六类型现有编码，不新增互不兼容的原生布尔/数组；**非法值保留并标待整理，
 *    不因转换失败变为空白**。所以「可转换」也只意味着「值得一试」，
 *    逐值校验失败的条目仍要落 `manual`，由执行层列清单。
 */
export function valuePlanForTypeChange(from: TemplateFieldType, to: TemplateFieldType): {
  plan: Extract<ValuePlan, 'convert' | 'manual'>
  note: string
} {
  if (from === to) return { plan: 'convert', note: '类型未变' }
  // 同族放大：短文本 → 长文本无损
  if (from === 'text' && to === 'textarea') return { plan: 'convert', note: '短文本转长文本无损' }
  // 同族收缩：长文本 → 短文本可能超 200 字被截
  if (from === 'textarea' && to === 'text') {
    return { plan: 'manual', note: '长文本转短文本可能超 200 字，需逐条确认' }
  }
  // 数字 → 文本：格式化后无损
  if (from === 'number' && to === 'text') return { plan: 'convert', note: '数字转文本无损（含单位仅展示）' }
  // 文本 → 数字：必须逐值校验可解析
  if (from === 'text' && to === 'number') {
    return { plan: 'convert', note: '文本转数字需逐值校验可解析，失败条目转人工' }
  }
  // 单选 → 文本：无损（存的就是选项字符串）
  if (from === 'select' && to === 'text') return { plan: 'convert', note: '单选转文本无损' }
  // 文本 → 单选：值不在选项内就必须人工
  if (from === 'text' && to === 'select') {
    return { plan: 'convert', note: '文本转单选需核对选项覆盖，未覆盖条目转人工' }
  }
  // 多选 ↔ 单选：结构不同（数组 ↔ 单值），不许自动转
  if (
    (from === 'multiSelect' && to === 'select')
    || (from === 'select' && to === 'multiSelect')
  ) {
    return { plan: 'manual', note: '多选与单选结构不同，需作者逐条处理' }
  }
  // 布尔 ↔ 文本：需逐值校验字面量
  if (from === 'boolean' && to === 'text') return { plan: 'convert', note: '布尔转文本无损' }
  if (from === 'text' && to === 'boolean') {
    return { plan: 'convert', note: '文本转布尔需逐值校验（真/假/是/否/1/0），失败条目转人工' }
  }
  // 引用类：端点结构变化，一律人工
  if (
    from === 'tableRef' || to === 'tableRef'
    || from === 'character' || to === 'character'
    || from === 'characters' || to === 'characters'
  ) {
    return { plan: 'manual', note: '引用类型端点结构变化，需作者逐条处理' }
  }
  // 日期/历法：编码不同，人工
  if (from === 'date' || to === 'date' || from === 'calendar' || to === 'calendar') {
    return { plan: 'manual', note: '日期/历法编码不同，需作者逐条处理' }
  }
  // other：只读展示类型，不许自动搬
  if (from === 'other' || to === 'other') {
    return { plan: 'manual', note: '未识别类型仅只读展示，需作者逐条处理' }
  }
  return { plan: 'manual', note: '暂不支持的自动转换，需作者逐条处理' }
}

// ────────────────────────── 主入口 ──────────────────────────

/**
 * 推演一次模板更换的完整影响。
 *
 * @param from 当前采用的模板；`null` = 尚未采用模板（3.1.3 老项目首次套用），
 *             全部字段按 `added` 计，不产生归档项。
 * @param to   目标模板（作者编辑后的新定义）。
 */
export function planTemplateChange(
  from: TemplateDef | null,
  to: TemplateDef,
  opts: PlanOptions = {},
): TemplateChangePlan {
  const items: FieldPlanItem[] = []
  const blockers: PlanBlocker[] = []
  const warnings: PlanWarning[] = []

  const fromFields = from?.fields ?? []
  const fromById = new Map(fromFields.map(f => [f.id, f]))

  // ── 目标模板自身健全性（与 from 无关，坏定义直接阻断） ──
  const seen = new Set<string>()
  for (const f of to.fields) {
    if (seen.has(f.id)) {
      blockers.push({ code: 'duplicate-field-id', detail: `字段 ID 重复：${f.id}`, fieldId: f.id })
    }
    seen.add(f.id)
    if (f.type === 'other') {
      blockers.push({
        code: 'unknown-type',
        detail: `字段「${f.label}」类型无法识别（${f.id}），将只读且不参与自动写入`,
        fieldId: f.id,
      })
    }
    if (!to.groups.some(g => g.id === f.groupId)) {
      blockers.push({
        code: 'group-missing',
        detail: `字段「${f.label}」引用了不存在的分组 ${f.groupId}`,
        fieldId: f.id,
      })
    }
  }

  // 名称字段：表格/卡片的记录标题，绑不到就是断头路
  const nameField = to.fields.find(f => f.id === to.nameFieldId && !f.archived)
  const nameFieldValid = Boolean(nameField)
  if (!nameFieldValid) {
    blockers.push({
      code: 'name-field-missing',
      detail: to.nameFieldId
        ? `名称字段 ${to.nameFieldId} 不存在或已归档，表格将无法显示记录标题`
        : '尚未指定名称字段，请先为模板绑定一个名称字段',
    })
  }

  // ── 同名候选索引（只建议，不绑定） ──
  const toByLabel = new Map<string, EffectiveField[]>()
  for (const f of to.fields) {
    const arr = toByLabel.get(f.label) ?? []
    arr.push(f)
    toByLabel.set(f.label, arr)
  }

  const valueCounts = opts.valueCounts ?? {}
  const valueScaleKnown = opts.valueCounts != null
  let affectedFieldCount = 0
  let affectedValueCount = 0

  const bumpAffected = (fieldId: string): void => {
    affectedFieldCount += 1
    affectedValueCount += valueCounts[fieldId] ?? 0
  }

  // ── 逐旧字段推演 ──
  for (const f of fromFields) {
    const hit = to.fields.find(t => t.id === f.id)
    if (hit) {
      const changes = diffField(f, hit)
      if (changes.length === 0) {
        items.push({
          fromId: f.id, toId: hit.id, disposition: 'kept', changes: [], valuePlan: 'keep',
        })
        bumpAffected(f.id)
        continue
      }
      // 同 ID 但定义有变
      const typeChange = changes.find(c => c.aspect === 'type')
      let valuePlan: ValuePlan
      let note: string | undefined
      if (typeChange) {
        const r = valuePlanForTypeChange(f.type, hit.type)
        valuePlan = r.plan
        note = r.note
        warnings.push({
          code: 'value-needs-conversion',
          detail: `字段「${f.label}」类型 ${f.type} → ${hit.type}：${r.note}`,
          fieldId: f.id,
        })
        warnings.push({
          code: 'type-changed',
          detail: `字段「${f.label}」改义，旧值按旧代次待整理，不按新语义读取`,
          fieldId: f.id,
        })
      } else if (isLayoutOnlyChange(changes)) {
        // 只换分组：值照样有效
        valuePlan = 'keep'
      } else {
        // 标签/说明/选项/权限/适用范围变化：含义可能已改
        valuePlan = 'stale-flag'
        note = '定义有变，旧值保留并标「旧代次待整理」'
      }
      // 选项收缩：已有值可能出界
      const optChange = changes.find(c => c.aspect === 'options')
      if (optChange) {
        const before = optionsOf(f)
        const after = optionsOf(hit)
        const lost = before.filter(o => !after.includes(o))
        if (lost.length > 0) {
          warnings.push({
            code: 'options-shrunk',
            detail: `字段「${f.label}」选项减少，已不存在的选项：${lost.join('、')}（相关旧值需人工核对）`,
            fieldId: f.id,
          })
        }
      }
      // 封闭枚举收紧：作者不能再增改选项
      if (!f.fixedOptions && hit.fixedOptions) {
        warnings.push({
          code: 'capability-tightened',
          detail: `字段「${f.label}」改为封闭枚举，选项不可再增改`,
          fieldId: f.id,
        })
      }
      // AI 权限变化：如实上报，不代为judgement
      const permChanges = changes.filter(c => c.aspect === 'permissions')
      for (const pc of permChanges) {
        const [key, val] = pc.to.split('=')
        if (key === 'aiWrite') {
          warnings.push({
            code: val === 'true' ? 'ai-write-opened' : 'ai-write-tightened',
            detail: val === 'true'
              ? `字段「${f.label}」新开放 AI 填写`
              : `字段「${f.label}」不再允许 AI 填写（既有已存值仍保留，但不再自动回填）`,
            fieldId: f.id,
          })
        }
        if (key === 'aiRead' && val === 'false') {
          warnings.push({
            code: 'ai-read-tightened',
            detail: `字段「${f.label}」不再允许 AI 参考，其已存值不再进入模型上下文与向量索引`,
            fieldId: f.id,
          })
        }
      }
      // 展示 / 检索权限收紧：隐藏只影响展示（不归档），但作者应当知情
      if (permChanges.some(pc => {
        const [key, val] = pc.to.split('=')
        return (key === 'table' || key === 'detail' || key === 'search') && val === 'false'
      })) {
        warnings.push({
          code: 'capability-tightened',
          detail: `字段「${f.label}」展示或检索权限收紧（隐藏仅影响展示，不影响已存值）`,
          fieldId: f.id,
        })
      }
      items.push({
        fromId: f.id, toId: hit.id, disposition: 'kept-modified', changes, valuePlan, ...(note ? { note } : {}),
      })
      bumpAffected(f.id)
      continue
    }

    // 旧字段在新模板里没有同 ID 的 ⇒ 归档；若显示名唯一命中，给一条建议
    const sameLabel = toByLabel.get(f.label) ?? []
    if (sameLabel.length === 1) {
      items.push({
        fromId: f.id,
        toId: undefined,
        disposition: 'suggested-map',
        changes: [],
        valuePlan: 'manual',
        suggestedTargetId: sameLabel[0].id,
        note: `旧字段「${f.label}」在新模板中显示名相同但 ID 不同（${sameLabel[0].id}）；`
          + '显示名相同不等于同一个字段，须作者确认后才映射',
      })
      warnings.push({
        code: 'same-label-suggestion',
        detail: `字段「${f.label}」可按显示名映射到 ${sameLabel[0].id}，但必须作者确认，不自动合并`,
        fieldId: f.id,
      })
    } else if (sameLabel.length > 1) {
      items.push({
        fromId: f.id,
        toId: undefined,
        disposition: 'archived',
        changes: [],
        valuePlan: 'archive-keep',
        note: `旧字段「${f.label}」在新模板中有 ${sameLabel.length} 个同名候选，无法建议映射，按归档处理`,
      })
      blockers.push({
        code: 'same-label-ambiguous',
        detail: `旧字段「${f.label}」对应多个同显示名新字段（${sameLabel.map(x => x.id).join('、')}），请先重命名消除歧义`,
        fieldId: f.id,
      })
    } else {
      items.push({
        fromId: f.id,
        toId: undefined,
        disposition: 'archived',
        changes: [],
        valuePlan: 'archive-keep',
        note: '字段在新模板中不存在，默认归档，旧值保留不删除',
      })
    }
    bumpAffected(f.id)
  }

  // ── 新字段 ──
  for (const t of to.fields) {
    if (fromById.has(t.id)) continue
    items.push({
      fromId: undefined,
      toId: t.id,
      disposition: 'added',
      changes: [],
      valuePlan: 'keep',
      note: '新增字段，历史无值，不影响既有资料',
    })
  }

  const summary = {
    kept: items.filter(i => i.disposition === 'kept').length,
    modified: items.filter(i => i.disposition === 'kept-modified').length,
    added: items.filter(i => i.disposition === 'added').length,
    archived: items.filter(i => i.disposition === 'archived').length,
    suggestedMaps: items.filter(i => i.disposition === 'suggested-map').length,
    needsManual: items.filter(i => i.valuePlan === 'manual' || i.valuePlan === 'convert').length,
  }

  // 🔴 首次采用模板（from=null）同样算语义变化：索引 / AI 候选要按新定义重建，
  //    不能因为「没有旧摘要可比」就当成什么都没发生。
  const semanticChanged = from == null ? to.fields.length > 0 : from.semanticDigest !== to.semanticDigest
  if (semanticChanged) {
    warnings.push({
      code: 'semantic-digest-changed',
      detail: '语义摘要变化，相关索引与 AI 候选将按失效规则处理',
    })
  }

  return {
    tabId: to.tabId,
    fromTemplateId: from?.templateId ?? '<none>',
    toTemplateId: to.templateId,
    items,
    summary,
    blockers,
    warnings,
    semanticChanged,
    nameFieldValid,
    affectedFieldCount,
    affectedValueCount,
    valueScaleKnown,
  }
}

/**
 * 计划是否「无事可做」：语义摘要一致、无阻断、无提示、没有需要作者点头的事。
 *
 * 🔴 用于**幂等迁移**（方案 §3.6 第 208 行）：同一份目标模板重复执行时
 *    第二次必须识别为 no-op，不能反复归档/改义/惊动同步。
 *    纯布局变化（分组调整）也算 no-op —— 旧值照样有效，没有需要作者确认的事
 *    （`valuePlan === 'keep'` 的 kept-modified 恰好就是「只动了布局」）。
 *
 * 🔴 两个保守前提：
 *    · `added === 0`：新增字段哪怕摘要没变，也是作者做了决定，不能装没事；
 *    · `fromTemplateId !== '<none>'`：首次采用模板永远是一次真实迁移。
 */
export function planIsNoop(plan: TemplateChangePlan): boolean {
  return (
    plan.fromTemplateId !== '<none>'
    && plan.summary.added === 0
    && !plan.semanticChanged
    && plan.blockers.length === 0
    && plan.warnings.length === 0
    && plan.items.every(i =>
      i.disposition === 'kept'
      || (i.disposition === 'kept-modified' && i.valuePlan === 'keep'))
  )
}
