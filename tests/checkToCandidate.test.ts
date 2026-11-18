// ============ 检查报告 → 修订候选 关联（3.6.0 · 审计项 12）契约闸 ============
//
// 守四件事：
//   ① 带入意图「取走即清空」——否则下一稿会莫名带上上一份报告（假来源比没有来源更糟）；
//   ② 项目不匹配就不给 —— 甲书的检查结论不能当乙书的依据；
//   ③ 要求文本只搬运报告已有内容（标题 + 级别），不替作者发挥；超量要如实说明；
//   ④ 写入链路真的存在：面板有入口、改写区会消费、候选真正落 `checkPayloadIds`。
import fs from 'node:fs'
import path from 'node:path'
import {
  clearPendingRevisionFromCheck, peekPendingRevisionForProject, requirementFromReport,
  setPendingRevisionFromCheck, takePendingRevisionForProject,
} from '../src/lib/revision/checkToCandidate'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

console.log('—— checkToCandidate：检查报告 → 候选（3.6.0 · 审计项 12）——')

// ---------- ① 一次性带入 ----------
{
  clearPendingRevisionFromCheck()
  ok('① 无带入时返回 null', takePendingRevisionForProject('p1') === null)

  setPendingRevisionFromCheck({ projectId: 'p1', chapterId: 'ch1', checkPayloadIds: ['r1', 'r1', 'r2'], requirement: '按报告改' })
  const peek = peekPendingRevisionForProject('p1')
  ok('① 只看不取：peek 两次都拿得到', peek !== null && peekPendingRevisionForProject('p1') !== null)
  ok('① 载荷 id 去重', peek?.checkPayloadIds.join(',') === 'r1,r2', JSON.stringify(peek?.checkPayloadIds))

  const taken = takePendingRevisionForProject('p1')
  ok('🔴 ① 取走一次后清空（避免下一稿带旧报告）',
    taken?.chapterId === 'ch1' && takePendingRevisionForProject('p1') === null)
}

// ---------- ② 项目隔离 ----------
{
  clearPendingRevisionFromCheck()
  setPendingRevisionFromCheck({ projectId: 'p1', chapterId: 'ch1', checkPayloadIds: ['r1'], requirement: '甲书的要求' })
  ok('🔴 ② 切到别的项目拿不到（不把甲书结论当乙书依据）', peekPendingRevisionForProject('p2') === null)
  ok('② 拿不到时**不清空**（作者可能只是切错了项目又切回来）', peekPendingRevisionForProject('p1') !== null)
  ok('② 空项目 id 也不给', peekPendingRevisionForProject('') === null)
  clearPendingRevisionFromCheck()
  ok('② 显式清空后为空', peekPendingRevisionForProject('p1') === null)
}

// ---------- ③ 要求文本 ----------
{
  const text = requirementFromReport({
    chapterTitle: '第三章 断桥',
    summary: '共 3 条发现',
    findings: [
      { level: '严重', title: '时间线冲突：上一章说三日后，这里写成次日' },
      { level: '中等', title: '人物称谓前后不一致' },
      { level: '提示', title: '可补一句环境' },
    ],
  })
  ok('③ 带章节名开头', text.startsWith('按检查报告修订本章（第三章 断桥）：'), text.slice(0, 30))
  ok('③ 只收严重/中等（提示级不进要求）', text.includes('时间线冲突') && text.includes('称谓') && !text.includes('可补一句环境'))
  ok('③ 编号成条，便于模型逐条处理', /1\. 时间线冲突/.test(text) && /2\. 人物称谓/.test(text))

  const many = requirementFromReport({
    findings: Array.from({ length: 9 }, (_, i) => ({ level: '严重', title: `问题${i + 1}` })),
  })
  ok('🔴 ③ 超量截断到 6 条并如实说明还剩几条', /问题1[\s\S]*问题6/.test(many) && !/问题7/.test(many) && /共 9 条/.test(many), many)

  const empty = requirementFromReport({ findings: [], summary: '仅有一条摘要' })
  ok('③ 没有发现时退回摘要，不产出空要求', empty.includes('仅有一条摘要'))

  const noTitle = requirementFromReport({ findings: [{ level: '严重' }] })
  ok('③ 缺标题也给出占位而不是空白行', noTitle.includes('（报告未给标题）'))
}

// ---------- ④ 链路真的接上了 ----------
{
  const panel = read('src/components/revision/CheckReportPanel.tsx')
  ok('🔴 ④ 报告面板有「以此发起修订」入口', panel.includes('以此发起修订') && panel.includes('setPendingRevisionFromCheck'))
  ok('④ 入口带上报告 id 作为载荷', /checkPayloadIds:\s*\[r\.id\]/.test(panel))
  ok('④ 没有章节归属的老报告禁用该入口', /disabled=\{!r\.chapterId\}/.test(panel))

  const section = read('src/components/creative/CreativeRewriteSection.tsx')
  ok('🔴 ④ 改写区消费带入（取走即清空）', section.includes('takePendingRevisionForProject'))
  ok('④ 带入的要求只填空框，不覆盖作者已写的内容', /prev\.trim\(\) \? prev : pending\.requirement/.test(section))
  ok('🔴 ④ 开始改写时把载荷 id 传下去', /checkPayloadIds:\s*ids/.test(section))

  const intake = read('src/lib/revision/candidateIntake.ts')
  ok('🔴 ④ 候选真的落 checkPayloadIds（并去重）',
    /checkPayloadIds\?: string\[\]/.test(intake) && /checkPayloadIds:\s*\[\.\.\.new Set\(input\.checkPayloadIds\)\]/.test(intake))

  const session = read('src/lib/creative/creativeSession.ts')
  ok('🔴 ④ 会话层透传到候选登记', /\.\.\.\(p\.checkPayloadIds\?\.length \? \{ checkPayloadIds: p\.checkPayloadIds \} : \{\}\)/.test(session))

  const store = read('src/lib/revision/candidateStore.ts')
  ok('④ 存储层原本就支持（不是新造字段）', store.includes('checkPayloadIds'))
}

console.log(`\n———— checkToCandidate：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
