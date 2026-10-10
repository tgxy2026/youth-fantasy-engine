// 3.0 · W1-2b 缺失即停 · 单测
//
// 盯两件事：
//   ① 三条「必需证据」判据（纯函数）—— 缺 / 不缺的分界；
//   ② 🔴 **接线闸**：续写缺失时必须是「停止生成」（throw），不许退回「提示一句就照发」。
import fs from 'node:fs'
import {
  checkContinuationFocus, checkRewriteTarget, checkAuditChapters, formatGap,
} from '../src/lib/evidenceGate'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— evidenceGate 用例开始 ——')

// ---------- ① 续写：焦点章定位 ----------
{
  ok('定位到本章 → 无缺口', checkContinuationFocus(true) === null)
  const g = checkContinuationFocus(false)
  ok('定位不到 → 有缺口', g !== null)
  ok('缺口带 code', g?.code === 'continuation-focus')
  ok('缺口讲清了「为什么会出问题」', !!g?.message && g.message.includes('衔接'))
  ok('缺口给了「下一步做什么」', !!g?.action && g.action.includes('刷新'))
}

// ---------- ② 改写：目标章要有正文 ----------
{
  ok('有正文 → 无缺口', checkRewriteTarget(true) === null)
  const g = checkRewriteTarget(false)
  ok('没正文 → 有缺口', g !== null && g?.code === 'rewrite-target')
  ok('缺口给了可行动作', !!g?.action)
}

// ---------- ③ 审计：至少两章 ----------
{
  ok('两章 → 无缺口', checkAuditChapters(2) === null)
  ok('十章 → 无缺口', checkAuditChapters(10) === null)
  const g1 = checkAuditChapters(1)
  ok('一章 → 有缺口', g1 !== null && g1?.code === 'audit-chapters')
  ok('缺口里写明了实际章数', !!g1?.message && g1.message.includes('1 章'))
  ok('0 / 负数 / NaN 一律有缺口（不炸）', checkAuditChapters(0) !== null && checkAuditChapters(-3) !== null && checkAuditChapters(NaN) !== null)
}

// ---------- ④ 文案拼接 ----------
{
  const g = checkContinuationFocus(false)!
  const s = formatGap(g)
  ok('formatGap 同时含说明与动作', s.includes(g.message) && s.includes(g.action))
}

// ---------- ⑤ 🔴 接线闸（源码级） ----------
{
  const jwj = fs.readFileSync('src/components/useJieWenJiModel.ts', 'utf8')
  ok('🔴 续写缺焦点章 ⇒ throw（停止生成）',
    /checkContinuationFocus\(src\.found\)[\s\S]{0,120}throw new Error\(formatGap/.test(jwj))
  ok('🔴 不再「提示一句就照发」（旧文案已移除）',
    !jwj.includes('本次续写只会带设定资料'))

  const cs = fs.readFileSync('src/lib/creativeSession.ts', 'utf8')
  ok('🔴 改写目标检查走统一口径（evidenceGate）',
    /checkRewriteTarget\(!!hit\.chapter\.content\.trim\(\)\)/.test(cs))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
