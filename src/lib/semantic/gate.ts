// ============ 语义检索 · 召回权限闸（注入前最后一道）============
//
// 3.2.0 §16.3 Q2-3：召回**最终注入前**必须重新加载当前权限与来源状态。
// 块里的原文是"建索引那一刻"的快照；作者之后关掉参考、归档字段、改类别、删来源，
// 旧块仍然在向量库里。没有这道闸，〖语义召回〗就成了绕过权限的第二条通道。
//
// 处置口径（逐条对应方案）：
//   · 块里任一字段失效（权限 / 归档 / 类别 / 字段值已变）⇒ **整块丢弃**，
//     绝不把旧原文直接注入（Q2-3）。
//   · 没有 `basis` 的旧块 ⇒ 先隔离（Q2-3）；界面由 `indexStatus` 提示重建。
//   · 字段配置读失败 ⇒ 含 `cf_*` 的块一律丢弃；纯内置字段的块继续（Q2-4）。
//   · 来源行被删 / D 级 / 角色视角下的 S 级 ⇒ 丢弃（Q2-2）。
//
// 🔴 本模块**不渲染、不嵌入**，只做「这块现在还能不能用」的判断。
//    依赖方向：gate → {db, fieldRules, secrecy}，不 import aiContext（后者 import inject）。
import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { isPrunedForAI, isSecretRow } from '@/lib/ai/secrecy'
import { hashOf } from '@/lib/semantic/chunk'
import { loadFieldRules, type FieldRules } from '@/lib/semantic/fieldRules'
import type { RecallHit } from '@/lib/semantic/recall'
import type { TableRow } from '@/lib/types'

/** 条目类别所在的列（图鉴四页签一致，与索引器同源） */
const CATEGORY_COL = '类别'

/** 卷台账在索引里的来源页签标识（不属于 TABS） */
const LEDGER_TAB_ID = 'chapter-master'

interface GateRow {
  id: string
  data: Record<string, string>
  /** 卡片名（角色卡的标题） */
  name?: string
}

export interface RecallGateOptions {
  projectId: string
  /** 角色视角：剔除当前被标为 S 级的来源 */
  hideSecretRows?: boolean
  /** 现存章节 id；给了就顺带剔除已删章节的旧块 */
  chapterIds?: Set<string> | null
  /** 单测注入点（生产不传） */
  deps?: {
    loadRows?: (pid: string, tabId: string) => Promise<GateRow[] | null>
    loadRules?: (pid: string, tab: (typeof TABS)[number]) => Promise<FieldRules>
  }
}

async function defaultLoadRows(pid: string, tabId: string): Promise<GateRow[] | null> {
  if (tabId === LEDGER_TAB_ID) {
    return (await db.getAllChapterLedgerRowsFor(pid)).map((r: TableRow) => ({ id: r.id, data: r.data }))
  }
  const tab = TABS.find(t => t.id === tabId)
  if (!tab) return null
  if (tab.type === 'table') {
    return (await db.getTableRowsFor(pid, tabId)).map((r: TableRow) => ({ id: r.id, data: r.data }))
  }
  if (tab.type === 'card') {
    return (await db.getCardRecordsFor(pid, tabId)).map(r => ({ id: r.id, data: r.data, name: r.name }))
  }
  return null
}

/** 当前行是否仍满足块里记录的字段依据 */
function fieldsStillValid(hit: RecallHit, row: GateRow, rules: FieldRules): boolean {
  const basis = hit.basis
  if (!basis) return false
  const category = typeof row.data[CATEGORY_COL] === 'string' ? row.data[CATEGORY_COL].trim() : ''

  for (const f of basis.fields) {
    // 值变了而索引还没重建 ⇒ 旧块是过期快照，不许注入
    const current = typeof row.data[f.key] === 'string' ? row.data[f.key].trim() : ''
    if (hashOf(current) !== f.digest) return false

    if (rules.kind === 'unavailable') {
      // 无法证明自定义字段授权 ⇒ 含 cf_* 的块整块丢弃；公开内置字段可继续
      if (f.key.startsWith('cf_')) return false
      continue
    }
    if (rules.kind === 'none') {
      // 非模板治理来源：没有字段权限，只保留上面的来源 / 值校验
      continue
    }
    const rule = rules.rules[f.key]
    if (!rule) {
      // 自定义字段缺席 = 已归档/已删除/关闭参考；权威规则下内置字段缺席同理
      if (f.key.startsWith('cf_') || rules.authoritative) return false
      continue
    }
    // 🔴 字段被删后重建（存储键复用、稳定 ID 换了）⇒ 旧块写的是另一个字段，丢弃
    if (rule.id !== f.id) return false
    // 🔴 改名（只动 label、键与值都没变）⇒ 旧块文本里仍是旧名字，丢弃这一块；
    //    没有 `label` 的历史块跳过（当时的索引没记，不能凭空判它失效）。
    if (f.label !== undefined && f.label !== rule.label) return false
    if (!rule.aiReadable) return false
    if (rule.appliesTo !== '*' && !rule.appliesTo.includes(category)) return false
  }
  return true
}

/**
 * 过滤召回命中：只留下「此刻仍获授权、来源仍存在」的块。
 *
 * **永不抛**（读库 / 读配置失败 ⇒ 相关块一律丢弃）：这道闸宁可不给资料，
 * 也不能把无法证明授权的原文交给模型。
 */
export async function filterRecallHitsByPermission(
  hits: RecallHit[],
  opts: RecallGateOptions,
): Promise<RecallHit[]> {
  if (hits.length === 0) return []
  const loadRows = opts.deps?.loadRows ?? defaultLoadRows
  const loadRules = opts.deps?.loadRules ?? loadFieldRules
  const rowsCache = new Map<string, Promise<GateRow[] | null>>()
  const rulesCache = new Map<string, Promise<FieldRules>>()

  const rowsOf = (tabId: string): Promise<GateRow[] | null> => {
    let p = rowsCache.get(tabId)
    if (!p) {
      p = Promise.resolve()
        .then(() => loadRows(opts.projectId, tabId))
        .catch(() => null)
      rowsCache.set(tabId, p)
    }
    return p
  }
  const rulesOf = (tab: (typeof TABS)[number]): Promise<FieldRules> => {
    let p = rulesCache.get(tab.id)
    if (!p) {
      p = Promise.resolve()
        .then(() => loadRules(opts.projectId, tab))
        .catch((e): FieldRules => ({
          kind: 'unavailable',
          reason: e instanceof Error ? e.message : String(e),
        }))
      rulesCache.set(tab.id, p)
    }
    return p
  }

  const out: RecallHit[] = []
  for (const hit of hits) {
    // 章节正文：没有字段权限，只需确认章节还在
    if (hit.kind === 'chapter') {
      if (opts.chapterIds && !opts.chapterIds.has(hit.refId)) continue
      out.push(hit)
      continue
    }
    // 知识库 / 自由对话不是项目模板资料，按各自来源规则处理（Q2 不扩大适用范围）
    if (hit.kind !== 'setting' && hit.kind !== 'summary') {
      out.push(hit)
      continue
    }

    const basis = hit.basis
    if (!basis || basis.v !== 1) continue // 历史块：没有授权依据 ⇒ 隔离

    const rows = await rowsOf(basis.tabId)
    if (!rows) continue
    const row = rows.find(r => r.id === hit.refId)
    if (!row) continue // 来源已删除

    if (isPrunedForAI(row.data)) continue // D 级：任何视角都不给
    if (opts.hideSecretRows && isSecretRow(row.data)) continue // S 级：角色视角剔除
    // 标题变了（如角色卡改名）⇒ 旧块里的标题也是过期快照
    if (basis.headDigest && row.name != null && hashOf(row.name.trim()) !== basis.headDigest) continue

    const tab = TABS.find(t => t.id === basis.tabId)
    if (!tab) {
      // 只有卷台账允许没有 TabDef；未知页签说明依据不可信
      if (basis.tabId !== LEDGER_TAB_ID) continue
      if (!fieldsStillValid(hit, row, { kind: 'none' })) continue
      out.push(hit)
      continue
    }

    const rules = await rulesOf(tab)
    if (!fieldsStillValid(hit, row, rules)) continue
    out.push(hit)
  }
  return out
}
