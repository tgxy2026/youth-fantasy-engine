// ============ 伏笔闭环引擎 ============
// 从「章节总表」反推每条伏笔的生命周期，比对「伏笔追踪」登记的状态，
// 产出：跨度告警 / 孤儿检测 / 前置未铺就 / 状态不一致 等可定位问题，
// 以及一张用于「伏笔看板」的分组数据（埋设中 / 进行中 / 已回收 / 孤儿）。
import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'
import { AuditIssue, splitCodes } from '@/lib/audit/audit'

export type ForeshadowStatus = '埋设中' | '进行中' | '已回收' | '已作废' | '孤儿'

export interface ForeshadowBoardItem {
  code: string
  content: string
  importance: string
  status: ForeshadowStatus
  plantChapters: string[]
  recycleChapters: string[]
  /** 埋设→回收的章节跨度（null 表示尚未闭环） */
  span: number | null
  issues: AuditIssue[]
}

export interface ForeshadowResult {
  issues: AuditIssue[]
  board: ForeshadowBoardItem[]
}

// 全书级伏笔建议跨度阈值（章）；卷级另算
const SPAN_BOOK = 200
const SPAN_VOLUME = 60

export async function auditForeshadow(): Promise<ForeshadowResult> {
  const [vols, chs, master, fores] = await Promise.all([
    db.getAllVolumes(),
    db.getAllChapters(),
    db.getAllChapterLedgerRows(),
    db.getTableRows('foreshadow'),
  ])

  // 全局章节序号与卷映射（与编辑器总表同步口径一致）
  const flat: Chapter[] = vols.flatMap(v => chs.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order))
  const globalIdx = new Map<string, number>()
  const titleById = new Map<string, string>()
  const volTitleById = new Map<string, string>()
  flat.forEach((c, i) => {
    globalIdx.set(c.id, i)
    titleById.set(c.id, c.title)
  })
  vols.forEach(v => { for (const c of chs) if (c.volumeId === v.id) volTitleById.set(c.id, v.title) })

  // 伏笔追踪索引（不区分大小写）
  const foreByCode = new Map<string, typeof fores[number]>()
  for (const f of fores) foreByCode.set((f.data['编号'] || '').toUpperCase(), f)

  // 从章节总表收集 埋设/回收 关系：row.id 形如 "ch-<chapterId>"
  const plantMap = new Map<string, string[]>()   // code -> chapterId[]
  const recycleMap = new Map<string, string[]>()
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    if (!cid || !globalIdx.has(cid)) continue
    for (const code of splitCodes(row.data['埋设伏笔编号'])) {
      ;(plantMap.get(code) ?? plantMap.set(code, []).get(code)!).push(cid)
    }
    for (const code of splitCodes(row.data['回收伏笔编号'])) {
      ;(recycleMap.get(code) ?? recycleMap.set(code, []).get(code)!).push(cid)
    }
  }

  const board: ForeshadowBoardItem[] = []
  const issues: AuditIssue[] = []
  let seq = 0

  for (const f of fores) {
    const code = (f.data['编号'] || '').toUpperCase()
    if (!code) continue
    const itemIssues: AuditIssue[] = []
    const planted = plantMap.get(code) ?? []
    const recycled = recycleMap.get(code) ?? []
    const statusField = f.data['状态'] || '未回收'
    const importance = f.data['重要度'] || '小伏笔'

    let status: ForeshadowStatus
    if (statusField === '已作废') {
      status = '已作废'
    } else if (recycled.length > 0) {
      status = '已回收'
      // 章节总表已登记回收，但伏笔表状态未同步
      if (statusField !== '已回收') {
        const chTitles = recycled.map(id => titleById.get(id) ?? id)
        itemIssues.push({
          id: `f-sh-${seq}`, severity: 'warn', category: '伏笔',
          title: `${code} 已登记回收但未同步状态`,
          detail: `章节总表在第 ${chTitles.join('、')} 登记了回收，但伏笔追踪状态仍为「${statusField}」。建议把状态改为「已回收」，闭环才完整。`,
          location: { kind: 'tab', tabId: 'foreshadow', hint: '伏笔追踪' },
        })
      }
    } else if (planted.length > 0) {
      status = '进行中'
    } else {
      status = '孤儿'
      itemIssues.push({
        id: `f-orphan-${seq}`, severity: 'warn', category: '伏笔',
        title: `${code} 是孤儿伏笔（从未埋设）`,
        detail: `该伏笔已在追踪表登记，但从未出现在任何章节的「埋设伏笔编号」里，读者无从知晓。若已埋设请回填章节总表；若废弃请把状态改为「已作废」。`,
        location: { kind: 'tab', tabId: 'chapter-master', hint: '章节总表' },
      })
    }

    // 跨度计算
    let span: number | null = null
    if (planted.length > 0 && recycled.length > 0) {
      const pIdx = Math.min(...planted.map(id => globalIdx.get(id)!))
      const rIdx = Math.max(...recycled.map(id => globalIdx.get(id)!))
      span = rIdx - pIdx
    }

    // 跨度告警
    if (span !== null) {
      const threshold = importance === '全书级' ? SPAN_BOOK : importance === '卷级' ? SPAN_VOLUME : Infinity
      if (span > threshold) {
        itemIssues.push({
          id: `f-span-${seq}`, severity: importance === '全书级' ? 'error' : 'warn', category: '伏笔',
          title: `${code} 回收跨度过大（${span} 章）`,
          detail: `重要度「${importance}」建议回收跨度不超过 ${threshold} 章。跨度过长读者易遗忘，建议在中间章节设节奏点（小呼应/道具再现）维持记忆。`,
          location: { kind: 'tab', tabId: 'foreshadow', hint: '伏笔追踪' },
        })
      }
    }

    // 前置未铺就：已回收却没埋设
    if (recycled.length > 0 && planted.length === 0) {
      itemIssues.push({
        id: `f-pre-${seq}`, severity: 'error', category: '伏笔',
        title: `${code} 回收前置条件未铺就`,
        detail: `章节总表已登记回收，但没有任何章节埋设过它，逻辑链断裂。请先在某章「埋设伏笔编号」登记埋设点。`,
        location: { kind: 'tab', tabId: 'chapter-master', hint: '章节总表' },
      })
    }

    issues.push(...itemIssues)
    board.push({
      code,
      content: f.data['伏笔内容'] || '（未填内容）',
      importance,
      status,
      plantChapters: planted.map(id => titleById.get(id) ?? id),
      recycleChapters: recycled.map(id => titleById.get(id) ?? id),
      span,
      issues: itemIssues,
    })
    seq++
  }

  // 额外的表级汇总问题：章节总表引用了不存在的伏笔编码
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    const chTitle = cid ? titleById.get(cid) ?? row.data['章节标题'] : row.data['章节标题']
    for (const code of [...splitCodes(row.data['埋设伏笔编号']), ...splitCodes(row.data['回收伏笔编号'])]) {
      if (!foreByCode.has(code)) {
        issues.push({
          id: `f-missing-${row.id}-${code}`, severity: 'error', category: '伏笔',
          title: `章节总表引用了不存在的伏笔 ${code}`,
          detail: `「${chTitle}」的埋设/回收列填写了 ${code}，但伏笔追踪里没有这一条。请核对编号或先去伏笔追踪登记。`,
          location: { kind: 'tab', tabId: 'foreshadow', hint: '伏笔追踪' },
        })
      }
    }
  }

  return { issues, board }
}
