// ============ 连续性校验器 ============
// 基于「章节总表 / 时间脉络 / 伏笔追踪 / 名词术语 / 角色卡」做确定性静态判定，
// 产出 10 类常见问题：8 类吃书冲突（时间倒流、境界回退、死者复活、人名未登记、
// 伏笔编号孤儿、伏笔状态不一致、术语重复、章节缺时间线登记）
// + 2 类连载节奏预警（爽点断档、存稿缓冲告急）。
import * as db from './db'
import type { Chapter, CardRecord } from './types'
import { AuditIssue, splitCodes, splitNames, parseStoryDateKey, extractChapterNo, cnNumToArabic } from './audit'
import { readAliases } from './aliases'
import { flattenChapters, chapterSeqMap } from './chapterSeq'

const DEATH_KEYWORDS = ['死', '亡', '陨', '卒', '退场', '兵解', '逝', '诛', '殁']

export async function auditContinuity(): Promise<AuditIssue[]> {
  const [vols, chs, master, timeline, fores, terms, allData, progress, hookpoints] = await Promise.all([
    db.getAllVolumes(),
    db.getAllChapters(),
    db.getAllChapterLedgerRows(),
    db.getTableRows('timeline'),
    db.getTableRows('foreshadow'),
    db.getTableRows('terms'),
    db.loadAllData(),
    db.getTableRows('progress'),
    db.getTableRows('hookpoints'),
  ])
  const cardRecs: CardRecord[] = allData.cardRecords

  const issues: AuditIssue[] = []
  let seq = 0
  const nid = () => `c-${seq++}`

  // 章节：真实叙事序（按 (卷序, 章序) 展平）
  const flat: Chapter[] = flattenChapters(vols, chs)
  // 1.9.2：章号一律由隐藏顺序字段派生，**不再解析章节标题**——
  // 作者把章名叫「第11章」「序章」「番外」都不影响故事时序判定。
  // 标了「不计入序号」的章（序章/番外/后记）seq 为 0，自动跳过与时间线相关的检查。
  const chapterNoOf = chapterSeqMap(vols, chs)
  const titleById = new Map(flat.map(c => [c.id, c.title]))

  // 角色卡姓名（用于「人名未登记」「死者复活」）
  const cardNames = new Set<string>()
  const deadNames = new Set<string>()
  for (const rec of cardRecs) {
    if (rec.name) cardNames.add(rec.name)
    // v1.6：别称也算已登记人名——出场人物里写别称不再误报「人名未登记」
    for (const a of readAliases(rec.tabId, rec.data)) cardNames.add(a)
    const st = Object.entries(rec.data).find(([k]) => k.endsWith('::人物状态'))?.[1] || ''
    if (DEATH_KEYWORDS.some(k => st.includes(k))) deadNames.add(rec.name)
  }

  // 关系网人物（也算已登记人名）
  const relRows = await db.getTableRows('relations')
  for (const r of relRows) {
    if (r.data['人物A']) cardNames.add(r.data['人物A'])
    if (r.data['人物B']) cardNames.add(r.data['人物B'])
  }

  // 伏笔编码集合（用于孤儿检测）
  const foreCodes = new Set(fores.map(f => (f.data['编号'] || '').toUpperCase()).filter(Boolean))

  // 时间脉络行 → 章节：用「章节标题」认人，序号取该章的派生序号。
  // 这样时间线的先后完全由隐藏顺序决定，与作者怎么填「章节号」无关（1.9.2）。
  const seqByTlTitle = (tlTitle: string): number => {
    const t = (tlTitle ?? '').trim()
    if (!t) return 0
    const hit = flat.find(c => {
      const ct = c.title ?? ''
      return ct === t || ct.endsWith(t) || ct.includes(t) || t.includes(ct)
    })
    return hit ? (chapterNoOf.get(hit.id) ?? 0) : 0
  }

  // ---------- 1) 时间倒流 ----------
  const tlSorted = [...timeline]
    .map(r => ({ r, no: seqByTlTitle(r.data['章节标题']) || extractChapterNo(r.data['章节号']) || 0, date: parseStoryDateKey(r.data['故事内时间']) }))
    .filter(x => x.no > 0)
    .sort((a, b) => a.no - b.no)
  for (let i = 1; i < tlSorted.length; i++) {
    const prev = tlSorted[i - 1], cur = tlSorted[i]
    if (prev.date != null && cur.date != null && cur.date < prev.date) {
      issues.push({
        id: nid(), severity: 'error', category: '连续性',
        title: `时间倒流：第${cur.no}章早于第${prev.no}章`,
        detail: `第${prev.no}章故事内时间为「${tlSorted[i - 1].r.data['故事内时间']}」，第${cur.no}章却是「${cur.r.data['故事内时间']}」，时间线倒流。请核对两章的「故事内时间」。`,
        location: { kind: 'tab', tabId: 'timeline', hint: '时间脉络' },
      })
    }
  }

  // ---------- 2) 境界回退 ----------
  // 只在**同一境界名**内比较层级数字（如 聚灵七重 → 聚灵三重）。
  // 跨境界（聚灵九重 → 凝罡一重）是突破，数字变小是正常的，无法凭字符串判大小，跳过。
  for (let i = 1; i < tlSorted.length; i++) {
    const cur = tlSorted[i]
    const prev = realmOf(tlSorted[i - 1].r.data['主角当前境界/年龄'])
    const curR = realmOf(cur.r.data['主角当前境界/年龄'])
    if (prev != null && curR != null && prev.realm === curR.realm && curR.lv < prev.lv) {
      issues.push({
        id: nid(), severity: 'warn', category: '连续性',
        title: `境界疑似回退：第${tlSorted[i].no}章`,
        detail: `第${tlSorted[i - 1].no}章境界「${tlSorted[i - 1].r.data['主角当前境界/年龄']}」，第${tlSorted[i].no}章却为「${cur.r.data['主角当前境界/年龄']}」。若非剧情设定（如散功/封印），请核对时间线。`,
        location: { kind: 'tab', tabId: 'timeline', hint: '时间脉络' },
      })
    }
  }

  // ---------- 3) 死者复活 ----------
  // 黑风这类角色会在「退场的那一章」的出场人物里出现（他就是被反杀的一方），
  // 那不算复活。因此只有当退场者出现在**其它**章节时才报。
  // 退场章：从角色卡「关键出场 / 首次出场 / 结局归宿」等字段里提到的章号推断。
  const exitChapterOf = new Map<string, number>()
  for (const rec of cardRecs) {
    if (!deadNames.has(rec.name)) continue
    const blob = Object.values(rec.data).join(' ')
    const nums = (blob.match(/第[一二三四五六七八九十百\d]+章/g) || [])
      .map(s => cnNumToArabic(s.replace(/第|章/g, '')))
      .filter(n => !Number.isNaN(n))
    if (nums.length) exitChapterOf.set(rec.name, Math.max(...nums))
  }
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    if (!cid) continue
    const chTitle = titleById.get(cid) ?? row.data['章节标题']
    const thisNo = chapterNoOf.get(cid) ?? 0
    for (const name of splitNames(row.data['出场人物'])) {
      if (!deadNames.has(name)) continue
      // 退场章本身出现不算复活
      const exitNo = exitChapterOf.get(name) ?? 0
      if (thisNo > 0 && exitNo > 0 && thisNo === exitNo) continue
      issues.push({
        id: nid(), severity: 'error', category: '连续性',
        title: `死者复活：${name}`,
        detail: `角色卡中「${name}」的人物状态含死亡/退场字样，却出现在「${chTitle}」的出场人物中。若非回忆/亡灵设定，请核对状态或出场章节。`,
        location: cid ? { kind: 'chapter', chapterId: cid, hint: chTitle } : { kind: 'tab', tabId: 'chapter-master' },
      })
    }
  }

  // ---------- 4) 人名未登记 ----------
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    if (!cid) continue
    const chTitle = titleById.get(cid) ?? row.data['章节标题']
    for (const name of splitNames(row.data['出场人物'])) {
      if (name.length < 2) continue
      if (cardNames.has(name)) continue
      issues.push({
        id: nid(), severity: 'info', category: '连续性',
        title: `出场人物未登记：${name}`,
        detail: `「${chTitle}」出场人物含「${name}」，但在角色卡（主要/次要/NPC）与关系网里都找不到。若是重要人物建议补卡；若是龙套/错字可忽略。`,
        location: cid ? { kind: 'chapter', chapterId: cid, hint: chTitle } : { kind: 'tab', tabId: 'chapter-master' },
      })
    }
  }

  // ---------- 5) 伏笔编号孤儿（章节引用了不存在的伏笔） ----------
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    if (!cid) continue
    const chTitle = titleById.get(cid) ?? row.data['章节标题']
    for (const code of [...splitCodes(row.data['埋设伏笔编号']), ...splitCodes(row.data['回收伏笔编号'])]) {
      if (!foreCodes.has(code)) {
        issues.push({
          id: nid(), severity: 'error', category: '连续性',
          title: `伏笔编号孤儿：${code}`,
          detail: `「${chTitle}」引用了伏笔 ${code}，但伏笔追踪无此条。请核对编号，或先去伏笔追踪登记。`,
          location: { kind: 'tab', tabId: 'foreshadow', hint: '伏笔追踪' },
        })
      }
    }
  }

  // ---------- 6) 伏笔状态不一致（章节已登记回收，但伏笔表未标已回收） ----------
  for (const row of master) {
    const cid = row.id.startsWith('ch-') ? row.id.slice(3) : null
    if (!cid) continue
    const chTitle = titleById.get(cid) ?? row.data['章节标题']
    for (const code of splitCodes(row.data['回收伏笔编号'])) {
      const f = fores.find(x => (x.data['编号'] || '').toUpperCase() === code)
      if (f && f.data['状态'] !== '已回收') {
        issues.push({
          id: nid(), severity: 'warn', category: '连续性',
          title: `伏笔状态未同步：${code}`,
          detail: `「${chTitle}」已登记回收 ${code}，但伏笔追踪状态为「${f.data['状态'] || '未回收'}」。建议把状态改为「已回收」。`,
          location: { kind: 'tab', tabId: 'foreshadow', hint: '伏笔追踪' },
        })
      }
    }
  }

  // ---------- 7) 术语重复（同一术语定义了多次） ----------
  const termCount = new Map<string, number>()
  for (const r of terms) {
    const t = (r.data['名称'] || '').trim()
    if (t) termCount.set(t, (termCount.get(t) ?? 0) + 1)
  }
  for (const [t, c] of termCount) {
    if (c > 1) {
      issues.push({
        id: nid(), severity: 'warn', category: '连续性',
        title: `术语重复定义：${t}`,
        detail: `名词术语中「${t}」出现了 ${c} 次。同一事物两个名字最易前后矛盾，请合并或改名其一。`,
        location: { kind: 'tab', tabId: 'terms', hint: '名词术语' },
      })
    }
  }

  // ---------- 8) 章节缺时间线登记 ----------
  const tlNos = new Set(timeline.map(r => seqByTlTitle(r.data['章节标题']) || extractChapterNo(r.data['章节号']) || 0).filter(n => n > 0))
  for (const c of flat) {
    const no = chapterNoOf.get(c.id)
    if (no && !tlNos.has(no)) {
      issues.push({
        id: nid(), severity: 'info', category: '连续性',
        title: `第${no}章未登记时间脉络`,
        detail: `「${c.title}」没有对应的《时间脉络》登记，时间对账将跳过本章。建议每写完一章登记一行，防时间线崩坏。`,
        location: { kind: 'chapter', chapterId: c.id, hint: c.title },
      })
    }
  }

  // ---------- 9) 爽点断档（相邻爽点间隔超 3 章，schema 承诺的预警） ----------
  // 章号认法与时间脉络同口径：先按「章节标题」认章取派生序号，回退解析「章节号」文本。
  {
    const hpSorted = [...hookpoints]
      .map(r => ({ r, no: seqByTlTitle(r.data['章节标题']) || extractChapterNo(r.data['章节号']) || 0 }))
      .filter(x => x.no > 0)
      .sort((a, b) => a.no - b.no)
    for (let i = 1; i < hpSorted.length; i++) {
      const prev = hpSorted[i - 1], cur = hpSorted[i]
      const gap = cur.no - prev.no
      if (gap > 3) {
        issues.push({
          id: nid(), severity: 'warn', category: '节奏',
          title: `爽点断档：第${prev.no}章到第${cur.no}章间隔 ${gap} 章`,
          detail: `《爽点节奏》里第${prev.no}章与第${cur.no}章之间间隔 ${gap} 章（超过 3 章预警线），中间 ${gap - 1} 章未登记任何爽点。连载读者耐心有限，建议回头补排小爽点，或确认该段有强钩子撑住。`,
          location: { kind: 'tab', tabId: 'hookpoints', hint: '爽点节奏' },
        })
      }
    }
  }

  // ---------- 10) 存稿缓冲告急（低于 3 章，schema 承诺的预警） ----------
  // 取「日期」最新且缓冲可解析的一行；整表没填过缓冲就不打扰。
  {
    const dated = progress
      .map(r => ({ date: (r.data['日期'] ?? '').trim(), buf: parseInt((r.data['存稿缓冲（章）'] ?? '').trim(), 10) }))
      .filter(x => x.date && !Number.isNaN(x.buf))
      .sort((a, b) => a.date.localeCompare(b.date))
    const last = dated[dated.length - 1]
    if (last && last.buf < 3) {
      issues.push({
        id: nid(), severity: 'warn', category: '节奏',
        title: `存稿缓冲告急：仅剩 ${last.buf} 章`,
        detail: `《写作进度》最近一天（${last.date}）登记的存稿缓冲为 ${last.buf} 章，低于 3 章预警线。缓冲见底容易被迫断更或赶稿降质，建议先补存 1-2 章再恢复日常更新。`,
        location: { kind: 'tab', tabId: 'progress', hint: '写作进度' },
      })
    }
  }

  return issues
}

/** 从 "淬体一重（暗）/16岁" 抽出境界名（"重"前的部分）与层级数字；无法解析返回 null */
function realmOf(s: string | undefined): { realm: string; lv: number } | null {
  if (!s) return null
  const m = s.match(/^(.*?)([一二三四五六七八九十\d]+)\s*重/)
  if (!m) return null
  const n = cnNumToArabic(m[2])
  if (Number.isNaN(n)) return null
  return { realm: m[1].trim(), lv: n }
}
