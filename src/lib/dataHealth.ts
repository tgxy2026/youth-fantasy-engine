// ============ 数据体检：确定性结构扫描（不依赖 AI） ============
//
// 与「AI 一致性深度自查」互补：AI 查"故事通不通"（语义矛盾），本引擎查"链接断没断"
// （数据结构层面的引用完整性）。纯程序遍历所有表格型页签的引用列，毫秒级、100% 确定、
// 精确到行、可跳转修复。覆盖五类问题：
//   1. 悬空引用：cr（跨表引用）列的值在源表对应列中找不到 → 多半是改名/删除后残留
//   2. 孤儿项：自引用父级（上级/层级归属）指向本表不存在的名称 → 父条目被删
//   3. 编号冲突：同一表出现重复「编号」
//   4. 必填空：主名称列（displayCol）未填写，行缺少主标识
//   5. 酒馆列表残留：酒馆的「列表项」指向的正文/内容已不存在（列表里看得见、点开是空的）。
//      这一类的覆盖面与上面四类不同 —— 它不在表格里，而在酒馆的索引 + 分条之间，故单列。
//      ⚠️ **只报告、不自动清理**（2026-09-20 决定）：幽灵的成因常常是「这一侧读失败 / 同步竞态」
//      而不是真的缺失，盲目删索引会把还能恢复的条目永久抹掉 —— 与「读数据失败必须锁写盘」
//      是同一类风险。清理入口待后续版本单独设计（带安全前置）。
// 另外独立校验"编号型引用"（如 章节总表的 埋设/回收伏笔编号、历史的 对应伏笔编号）：
//   值为字母+数字编码时，按前缀映射到目标表，确认该编码真实存在。

import { TABS, getTab, GEO_MAPS_TAB } from './schema'
import { getTableRows } from './db'
import type { AuditIssue, AuditLocation } from './audit'
// ⚠️ `import type` 编译后被完全擦除，**不会**把酒馆存储层拽成静态依赖（真正的取用在下面动态 import）
import type { TavernGhostGroup } from './tavern/store'

/** 编码前缀 → 目标表（用于编号型引用校验） */
const PREFIX_TAB: Record<string, string> = {
  N: 'nations', G: 'geography', R: 'races', I: 'items', H: 'history',
  T: 'terms', F: 'foreshadow', LINE: 'subplots', S: 'secrets',
  C: 'changelog', IDEA: 'ideas', MAP: 'geomaps',
}
const CODE_RE = /^(N|G|R|I|H|T|F|LINE|S|C|IDEA|MAP)\d/i

export interface HealthResult {
  issues: AuditIssue[]
  scannedTables: number
  /**
   * 可清理的酒馆幽灵分组 —— 与 `issues` 里那几条**同源**，靠 `issueId` 关联。
   *
   * 📌 单独带出来、而不是往 `AuditIssue` 上加字段：后者是审计层的**公共**类型，
   *    没有理由知道「酒馆」这种具体业务；而且界面若靠解析 `title` 文案去认，
   *    文案一改就**静默失配**（按钮凭空消失）。用 id 关联是稳的。
   */
  tavernGhosts?: TavernGhostInfo[]
}

/** 一条「可清理的酒馆幽灵」分组（供界面在该 issue 卡片上挂「清理」按钮） */
export interface TavernGhostInfo {
  /** 对应 `issues` 里那一条的 id */
  issueId: string
  /** 哪一组索引（决定清理时调哪个 prune） */
  group: TavernGhostGroup
  /** 人类可读的组名（弹确认框时用） */
  label: string
  /** 该组检出条数 */
  count: number
}

export async function runDataHealthCheck(): Promise<HealthResult> {
  const issues: AuditIssue[] = []
  // 《地图》是独立数据表（不在 TABS 里），但它是《地理风物》「所属地图」列的**引用目标** ——
  // 不并进来的话，refValues 取不到它，所有已指派的地图归属都会被误报成「悬空引用」。
  const tableTabs = [...TABS, GEO_MAPS_TAB].filter(t => t.type === 'table')
  const counter = { n: 0 }
  const push = (
    severity: AuditIssue['severity'],
    category: string,
    title: string,
    detail: string,
    loc?: AuditLocation,
  ): string => {
    counter.n += 1
    const id = `H${counter.n}`
    issues.push({ id, severity, category, title, detail, location: loc })
    return id
  }
  /** 第 5 类里记录「哪条 issue 对应哪一组可清理的幽灵」，供界面挂清理按钮 */
  const tavernGhosts: TavernGhostInfo[] = []

  // 预取所有表格数据
  const cache = new Map<string, { id: string; data: Record<string, string> }[]>()
  for (const t of tableTabs) {
    const rows = await getTableRows(t.id)
    cache.set(t.id, rows.map(r => ({ id: r.id, data: r.data })))
  }

  // 建索引：refTab→refCol 取值集合（用于 cr 悬空校验）
  const refValues = (tabId: string, col: string) => {
    const set = new Set<string>()
    for (const r of cache.get(tabId) ?? []) {
      const v = (r.data[col] || '').trim()
      if (v) set.add(v)
    }
    return set
  }
  // 建索引：表→编号集合（用于编号型引用校验）
  const codeIndex = new Map<string, Set<string>>()
  for (const t of tableTabs) {
    const has = (t.columns ?? []).some(c => c.name === '编号')
    if (!has) continue
    const set = new Set<string>()
    for (const r of cache.get(t.id) ?? []) {
      const v = (r.data['编号'] || '').trim().toUpperCase()
      if (v) set.add(v)
    }
    codeIndex.set(t.id, set)
  }

  for (const t of tableTabs) {
    const rows = cache.get(t.id) ?? []
    const cols = t.columns ?? []
    const displayCol = t.displayCol

    // —— 1) 跨表引用悬空（cr 列，含自引用父级=孤儿项）——
    for (const col of cols) {
      if (col.type !== 'tableRef' || !col.refTab || !col.refCol) continue
      const refTab = col.refTab
      const refCol = col.refCol
      const allowed = refValues(refTab, refCol)
      const selfRef = refTab === t.id
      const refName = selfRef ? t.name : (getTab(refTab)?.name ?? refTab)
      for (const row of rows) {
        const v = (row.data[col.name] || '').trim()
        if (!v || allowed.has(v)) continue
        push(
          'error',
          selfRef ? '孤儿项' : '悬空引用',
          selfRef ? `「${col.name}」指向不存在的父级` : `「${col.name}」引用悬空`,
          `《${t.name}》·「${row.data[displayCol ?? ''] || '(无名称)'}」的「${col.name}」=「${v}」，但在${selfRef ? '本表' : `《${refName}》`}的「${refCol}」中找不到对应值。多半是源条目被改名或删除后残留，建议改为正确值或清理该行。`,
          { kind: 'row', tabId: t.id, rowId: row.id, hint: col.name },
        )
      }
    }

    // —— 2) 编号冲突 ——
    if (cols.some(c => c.name === '编号')) {
      const byCode = new Map<string, { name: string; rowId: string }[]>()
      for (const row of rows) {
        const v = (row.data['编号'] || '').trim()
        if (!v) continue
        if (!byCode.has(v)) byCode.set(v, [])
        byCode.get(v)!.push({ name: row.data[displayCol ?? ''] || row.id, rowId: row.id })
      }
      for (const [code, list] of byCode) {
        if (list.length <= 1) continue
        const first = list[0]
        push(
          'error',
          '编号冲突',
          `编号「${code}」重复`,
          `《${t.name}》中有 ${list.length} 行使用了相同编号「${code}」：${list.map(l => l.name).join('、')}。编号应唯一，重复会导致跳转与引用错位。`,
          { kind: 'row', tabId: t.id, rowId: first.rowId, hint: '编号' },
        )
      }
    }

    // —— 3) 必填空（主名称列）——
    if (displayCol) {
      for (const row of rows) {
        const v = (row.data[displayCol ?? ''] || '').trim()
        if (v) continue
        push(
          'warn',
          '必填空',
          `「${displayCol}」为空`,
          `《${t.name}》有一行的主标识「${displayCol}」未填写，该行缺少名称，会影响检索、联动与跳转定位。`,
          { kind: 'row', tabId: t.id, rowId: row.id, hint: displayCol },
        )
      }
    }

    // —— 4) 编号型引用悬空（埋设/回收伏笔编号 等纯文本编码列）——
    for (const col of cols) {
      if (col.name === '编号' || col.type === 'tableRef') continue
      if (!col.name.includes('编号')) continue
      for (const row of rows) {
        const raw = (row.data[col.name] || '').trim()
        if (!raw) continue
        for (const token of raw.split(/[,，、;\s]+/).map(s => s.trim()).filter(Boolean)) {
          const m = token.match(CODE_RE)
          if (!m) continue
          const prefix = (m[1] ?? '').toUpperCase()
          const target = PREFIX_TAB[prefix]
          if (!target) continue
          const set = codeIndex.get(target)
          if (set && !set.has(token.toUpperCase())) {
            push(
              'error',
              '悬空引用(编号)',
              `「${col.name}」指向不存在的编号`,
              `《${t.name}》·「${row.data[displayCol ?? ''] || '(无名称)'}」的「${col.name}」含编码「${token}」，但《${getTab(target)?.name ?? target}》中没有该编号。多半是对应条目被删或编号改过。`,
              { kind: 'row', tabId: t.id, rowId: row.id, hint: col.name },
            )
          }
        }
      }
    }
  }

  // —— 5) 酒馆列表「索引项 vs 分条」成对性（幽灵条目）——
  //
  // 🔴 必须追加在**最后**，不能插进上面的循环里：issue id 是 `H${counter.n}` 递增的，而本页的
  //    「忽略」会把 id **持久化**在 healthIgnoredIds 里 —— 中途插入新检查会让作者此前忽略的 id
  //    **错位到别的条目上**（静默失效：忽略的是 A，实际隐藏的是 B）。
  //
  // 🔴 用**动态 import**，不用顶部静态 import。但要如实说清：理由是**防御性**的，不是"现在的体积"。
  //    2026-09-20 实测过（动态 vs 静态各构建一次，比产物体积）：**当前**分包结构下两者几乎无差
  //    （主包 +0.00 kB / CheckTools −0.40 kB）—— 因为本页 CheckTools 自身就是懒加载 chunk，而
  //    `tavern/store` 早已被 Tavern* 组件引用成独立 chunk。原先这里写的是"静态 import 会把酒馆
  //    存储层无条件打进主包"，**实测不成立**，别照抄到别处。
  //    留着动态 import 是为了防**将来**的改动（比如有人把 CheckTools 收回主包、或改 manualChunks）：
  //    `check-tools` 在 FEATURE_TIER 里是 locked（永远在），而酒馆那套全是 optional —— 一个 locked
  //    模块不该在**模块图**里强依赖 optional 模块。静态 import 一旦把前者收回主包，就会连带把酒馆
  //    存储层拖给每个项目的每个用户；动态 import 天然免疫。
  //    同一条惯例见 seedData.ts（「动态 import 同样是为了不把酒馆引擎拖进主包」）—— 那边确实在主包路径上。
  //    这里**不判功能开关**：未启用酒馆时三个索引本就是空的，检测结果自然是 0 条，判了反而多一处耦合。
  //
  // 📌 这一类的检测能力早就写好了（`tavern/store.ts` 的 auditSessions / auditFreeChars /
  //    auditFreeSessions），一直**没有产品入口**、被登记为「能力缺口」白名单保护。
  //    2026-09-20 复核时纠正了一处历史误记：不只是自由模式没接，**剧情模式同样没接**
  //    （`pruneGhostSessions` 当时只被 tests 调用）—— 缺口是两种模式的 6 个函数全套。
  try {
    const { auditSessions, auditFreeChars, auditFreeSessions } = await import('./tavern/store')
    // 三组各取自己有的名字字段：会话两项是 title、角色卡是 name
    const groups: { group: TavernGhostGroup; label: string; how: string; items: string[] }[] = [
      { group: 'sessions', label: '剧情推演会话', how: '这场推演的对话记录', items: (await auditSessions()).ghosts.map(g => g.title) },
      { group: 'freeChars', label: '自由对话角色卡', how: '这张角色卡的设定与记忆', items: (await auditFreeChars()).ghosts.map(g => g.name) },
      { group: 'freeSessions', label: '自由对话会话', how: '这场对话的记录', items: (await auditFreeSessions()).ghosts.map(g => g.title) },
    ]
    for (const g of groups) {
      const n = g.items.length
      if (!n) continue
      const shown = g.items.slice(0, 6).map(s => s || '(无标题)').join('、')
      const issueId = push(
        'warn',
        '酒馆列表残留',
        `酒馆「${g.label}」有 ${n} 条残留`,
        `${g.label}的列表里有 ${n} 条记录，但${g.how}已经不在了 —— 列表里看得见、点开是空的。` +
        `多为删除或跨设备同步过程中的残留，通常不影响你已有内容的正确性。` +
        `涉及：${shown}${n > 6 ? ` 等 ${n} 条` : ''}。` +
        `可用这条结果上的「清理」把列表项从索引里去掉 —— 只动索引、不碰正文，清理前会再复判一次并留一份备份。`,
      )
      tavernGhosts.push({ issueId, group: g.group, label: g.label, count: n })
    }
  } catch (e) {
    // 酒馆模块加载失败 / 存储读取异常：跳过这一类即可，绝不拖垮其余几类检查
    console.warn('[dataHealth] 酒馆列表成对性检查跳过：', e)
  }

  // 严重度排序：error → warn → info
  const order = { error: 0, warn: 1, info: 2 } as const
  issues.sort((a, b) => order[a.severity] - order[b.severity])

  return {
    issues,
    scannedTables: tableTabs.length,
    ...(tavernGhosts.length > 0 ? { tavernGhosts } : {}),
  }
}
