// ============ 文风体检 ============
// 读取《写作规范》表的"个人坏习惯清单"与"标点规范"，对当前章正文做静态体检：
// ① 坏习惯高频词命中（如"顿时""瞬间"滥用）；② 省略号误用（…/... 代替 ……）；
// ③ 视角切换规则 / 数字写法 的温和提醒（无法直接分析正文视角，仅提示人工核对）。
// 建立在竞品普遍缺失的「写作规范」数据模型之上，是差异化功能。
import * as db from '@/lib/db'
import { AuditIssue } from '@/lib/audit'
import { contextSnippet } from '@/lib/contextSnippet'

/**
 * 把《写作规范》（`style` 表）压成一段「字段：值」上下文，供文风类 AI 任务注入。
 * 🔴 单一源（2026-10-01 六维审计 · 扫描器对齐）：文风体检（`runAiStyle`）与颉文姬「选区改稿」
 *    （`runRewrite`）原先各写一份**逐字相同**的格式化逻辑 —— 口径一旦要改（如截断长度），
 *    两处必然漂移。这里收敛成一处。
 *    规则：键名去掉 `模块::` 前缀、每值截 200 字、丢掉长度 ≤2 的空壳项。
 */
export async function styleContextForAI(): Promise<string> {
  const style = await db.getFormData('style').catch(() => ({} as Record<string, string>))
  return Object.entries(style)
    .map(([k, v]) => `${k.replace(/^.*::/, '')}：${(v ?? '').toString().slice(0, 200)}`)
    .filter(s => s.length > 2)
    .join('\n')
}

export async function auditStyle(content: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = []
  if (!content || !content.trim()) {
    issues.push({ id: 's-empty', severity: 'info', category: '文风', title: '本章暂无正文', detail: '文风体检需要正文内容。请先写作，再点体检。' })
    return issues
  }

  const all = await db.loadAllData()
  const style = all.formData.find(f => f.tabId === 'style')
  const styleMissing = !style
  const get = (name: string) => {
    const key = Object.keys(style?.data ?? {}).find(k => k.endsWith(`::${name}`))
    return key ? (style!.data[key] || '') : ''
  }

  const badHabits = get('已知坏习惯清单')
  const punct = get('标点规范')
  const povRule = get('视角切换规则')

  // ① 坏习惯高频词：从 "高频词：\"顿时\"\"瞬间\"滥用" 中抽取被引号包裹的词
  if (badHabits) {
    const quoted = [...badHabits.matchAll(/[“"]([^”"]+)[”"]/g)].map(m => m[1].trim()).filter(Boolean)
    // 也兼容直接写词、用顿号/斜杠分隔的情况
    const explicit = badHabits.split(/[、/，,]/).map(s => s.replace(/[“"”]/g, '').trim()).filter(w => w.length >= 2 && !w.includes('：') && !w.includes(':'))
    const words = new Set([...quoted, ...explicit])
    // 去掉明显是描述性的串（含"滥用""高频"等）
    const stop = ['高频词', '滥用', '坏习惯', '清单', '自检']
    for (const w of words) {
      if (stop.some(s => w.includes(s))) continue
      if (!w) continue
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      const m = content.match(re)
      if (m && m.length > 0) {
        const idx = content.indexOf(w)
        const ctx = contextSnippet(content, idx, w.length)
        issues.push({
          id: `s-habit-${w}`, severity: m.length >= 3 ? 'warn' : 'info', category: '文风',
          title: `坏习惯词「${w}」出现 ${m.length} 次`,
          detail: `《写作规范》把你列的坏习惯清单含「${w}」。本章出现 ${m.length} 次，建议酌情替换或精简，保持文风干净。\n示例：${ctx}`,
        })
      }
    }
  }

  // ② 省略号误用：三个英文句点 "..."
  const dotMatch = content.match(/\.\.\./g)
  if (dotMatch) {
    issues.push({
      id: 's-ellipsis', severity: 'warn', category: '文风',
      title: `检测到 ${dotMatch.length} 处 "..."（英文句点）`,
      detail: punct
        ? `《写作规范》要求：${punct}。正文里出现了 ${dotMatch.length} 处三个英文句点，建议统一改为中文省略号"……"。`
        : `正文出现 ${dotMatch.length} 处三个英文句点"..."，建议统一改为中文省略号"……"（可在《写作规范·格式规范》登记你的标点偏好）。`,
    })
  }

  // ③ 视角切换规则：温和提醒（无法自动分析正文视角）
  if (povRule) {
    issues.push({
      id: 's-pov', severity: 'info', category: '文风',
      title: '视角切换规则（人工核对）',
      detail: `你立的视角规则：${povRule}\n本检查无法直接分析正文视角归属，请人工确认本章切换次数与方式符合要求。`,
    })
  }

  if (issues.length === 0) {
    issues.push({ id: 's-ok', severity: 'info', category: '文风', title: '本章文风体检通过 ✓', detail: styleMissing ? '当前项目未登记《写作规范》，本次仅检查了省略号误用，未发现问题。' : '未命中《写作规范》里的坏习惯词，也未发现省略号误用。继续保持。' })
  }
  // 未登记《写作规范》时，文风体检的坏习惯词 / 标点规范 / 视角规则检查无数据源，给出诚实说明而非假装"全部通过"（旧版极简/精简项目也不提供该页签，逻辑等同）
  if (styleMissing) {
    issues.push({ id: 's-style-missing', severity: 'info', category: '文风', title: '《写作规范》未登记', detail: '未找到《写作规范》内容，坏习惯词 / 标点规范 / 视角规则检查暂不生效。如需这些检查，请在「写作规范」页签填写内容。本节已对正文做了省略号（……）误用检查。' })
  }

  return issues
}
