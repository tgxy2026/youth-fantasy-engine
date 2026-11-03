// 3.0 · W1-3 模型「拒答」感知 · 单测
//
// 盯三件事：
//   ① 三层判据（结构化 finish_reason / HTTP 状态+安全词 / 文本启发式）；
//   ② 🔴 `describeApiError` 的**分流**：400/403 + 安全词 ⇒ 判「内容被拒」，不再把作者引向查配置；
//   ③ 源码闸：chat.ts 真的读了 `finish_reason`（此前全仓零读取）。
import fs from 'node:fs'
import {
  isRefusalStatus, looksLikeSafetyMessage, looksLikeRefusalText, extractPlatformMessage,
  describeRefusal, describeApiError, AIRefusalError, isRefusal,
} from '../src/lib/aiCore/transport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— aiRefusal 用例开始 ——')

// ---------- ① 拒答类状态码 ----------
{
  ok('400 属拒答状态', isRefusalStatus(400))
  ok('403 属拒答状态', isRefusalStatus(403))
  ok('422 / 451 属拒答状态', isRefusalStatus(422) && isRefusalStatus(451))
  ok('200 / 404 / 429 / 500 不属拒答状态', ![200, 404, 429, 500].some(isRefusalStatus))
}

// ---------- ② 安全类关键词 ----------
{
  ok('英文 content_policy 命中', looksLikeSafetyMessage('{"error":{"message":"content_policy_violation"}}'))
  ok('英文 data_inspection_failed 命中', looksLikeSafetyMessage('data_inspection_failed'))
  ok('英文 sensitive 命中', looksLikeSafetyMessage('sensitive content detected'))
  ok('中文「内容安全」命中', looksLikeSafetyMessage('请求内容安全审核未通过'))
  ok('中文「敏感内容」命中', looksLikeSafetyMessage('包含敏感内容，已拦截'))
  ok('普通「模型名不存在」不命中', !looksLikeSafetyMessage('model not found'))
  ok('普通「参数错误」不命中', !looksLikeSafetyMessage('invalid parameter: temperature'))
}

// ---------- ③ 拒答模板文本（只看开头，避免长正文误报） ----------
{
  ok('中文「抱歉，我无法…」命中', looksLikeRefusalText('抱歉，我无法生成这样的内容。'))
  ok('中文「作为 AI…」命中', looksLikeRefusalText('作为一个AI助手，我不能继续这个请求。'))
  ok('英文 "I cannot" 命中', looksLikeRefusalText('I cannot help with that request.'))
  ok('正常正文不命中', !looksLikeRefusalText('夜色如墨，李默握紧了手中的断岳剑。'))
  ok('空串不命中', !looksLikeRefusalText(''))
  ok('🔴 长正文中后段出现「我无法」不误报（只看开头 200 字）',
    !looksLikeRefusalText('第一段正常叙述。'.repeat(60) + '我无法认同他的做法。'))
}

// ---------- ④ 平台原话提取 ----------
{
  ok('JSON 抽 error.message', extractPlatformMessage('{"error":{"message":"内容违规"}}') === '内容违规')
  ok('JSON 抽 message', extractPlatformMessage('{"message":"blocked by policy"}') === 'blocked by policy')
  ok('纯文本退化返回', extractPlatformMessage('plain text reason').includes('plain text'))
}

// ---------- ⑤ describeRefusal 讲清三件事 ----------
{
  const s = describeRefusal('safety-http', '内容违规被拦截')
  ok('① 说明「不是配置错」', s.includes('不是') && (s.includes('密钥') || s.includes('配置')))
  ok('② 带平台原话', s.includes('内容违规被拦截'))
  ok('③ 给可行动作（含换本地模型）', s.includes('本地模型') && s.includes('平台'))
  ok('三种 kind 都能生成文案',
    ['content-filter', 'safety-http', 'refusal-text'].every(k => describeRefusal(k as never, '').length > 20))
}

// ---------- ⑥ 结构化错误类 ----------
{
  const e = new AIRefusalError('content-filter', '')
  ok('isRefusal 认得出', isRefusal(e))
  ok('kind 正确', e.kind === 'content-filter')
  ok('name 已设（便于日志区分）', e.name === 'AIRefusalError')
  ok('message 即拒答文案', e.message.includes('内容政策'))
  ok('普通错误不被误认', !isRefusal(new Error('x')))
}

// ---------- ⑦ 🔴 describeApiError 分流 ----------
{
  const safety400 = describeApiError(400, '{"error":{"message":"content_policy_violation"}}')
  ok('🔴 400 + 安全词 → 判「内容被平台拒绝」（不再引向查模型名）',
    safety400.includes('内容被平台拒绝'))
  const plain400 = describeApiError(400, '{"error":{"message":"model not found"}}')
  ok('400 + 普通错误 → 仍是原「模型名」文案',
    plain400.includes('模型名') && !plain400.includes('内容被平台拒绝'))
  const safety403 = describeApiError(403, 'sensitive content detected')
  ok('🔴 403 + 安全词 → 判「内容被平台拒绝」（不再引向查密钥）',
    safety403.includes('内容被平台拒绝'))
  const plain403 = describeApiError(403, '{"error":{"message":"permission denied"}}')
  ok('403 + 普通错误 → 仍是原「密钥」文案',
    plain403.includes('密钥') && !plain403.includes('内容被平台拒绝'))
}

// ---------- ⑧ 源码闸（接线是否真的落地） ----------
{
  const src = fs.readFileSync('src/lib/aiCore/chat.ts', 'utf8')
  ok('🔴 chat.ts 真的读 finish_reason（此前全仓零读取）', src.includes('finish_reason'))
  ok('🔴 content_filter ⇒ 抛 AIRefusalError', src.includes("=== 'content_filter'") && src.includes('AIRefusalError'))
  ok('🔴 HTTP 错误先分流（isRefusalStatus + looksLikeSafetyMessage）',
    src.includes('isRefusalStatus(res.status) && looksLikeSafetyMessage(txt)'))
  ok('🔴 流式也有文本启发式检测', src.includes('looksLikeRefusalText'))

  // 伴写（§14.1 唯一「连理由都不展示」的消费点）：拒答要立即提示 + 熔断，不白等 N 次
  const ghost = fs.readFileSync('src/components/editor/useNovelEditorGhost.ts', 'utf8')
  ok('🔴 伴写识别拒答并给专门提示',
    ghost.includes('isRefusal(e)') && ghost.includes("showToast(e.message, 'error', 8000)"))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
