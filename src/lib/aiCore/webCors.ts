// ============ 网页形态「浏览器直连厂商」的跨域（CORS）台账（3.4.2 · 规划 §4.F.3 / D-3）============
//
// 为什么单独一个模块：网页版没有服务端 AI 代理，请求是**浏览器直接打到厂商域名**的，
// 所以「这个协议在网页形态能不能用」不由我们决定，而由厂商的 CORS 响应头决定。
// 规划要求「未通过即在网页形态标不支持、如实留痕，不伪装可用」——
// 这条要求要落地，就得有一张**带结论状态的台账**，界面照它说话，而不是散落几句文案。
//
// 🔴 状态只有四种，且必须用证据说话：
//    · `pass`          —— 浏览器预检拿到允许来源 / 实际请求成功（有留证）
//    · `blocked`       —— 浏览器预检被明确拒绝（有留证）
//    · `not-run`       —— 没跑通判定（网络不可达、代理干扰、环境不具备）—— **不等于通过，也不等于被拒**
//    · `not-applicable`—— 该协议在网页形态根本不走浏览器直连（本机端点被 P9 策略禁用）
//
// 🔴 当前全表 `not-run` 的原因（2026-11-07 实测，证据见 `docs/3.4.2-验收复核-2026-11-07.md`）：
//    浏览器侧一律 `Failed to fetch`，Node 侧 OPTIONS 要么超时、要么 403 且无 CORS 头；
//    而本机出网走代理 —— `Failed to fetch` **分不清**「跨域被拒」与「网络不可达」。
//    所以既不能写「网页可用」，也不能写「被 CORS 拒绝」。**保持 not-run 才是如实。**
//    拿到干净网络后逐家重跑预检，把结论填进这张表即可（界面文案会自动跟着变）。

import type { WireProtocol } from '@/lib/aiCore/protocol'
import { WEB } from '@/lib/app/platform'

/** 单条结论 */
export type CorsVerdict = 'pass' | 'blocked' | 'not-run' | 'not-applicable'

/** 台账（改这里就等于改界面口径 —— 界面不另写判断） */
export const PROTOCOL_WEB_CORS: Record<WireProtocol, CorsVerdict> = {
  // Ollama 在网页形态被 P9 策略禁用，压根不走浏览器直连，谈不上 CORS
  'ollama': 'not-applicable',
  'openai-chat': 'not-run',
  'anthropic': 'not-run',
  'gemini': 'not-run',
  'openai-responses': 'not-run',
}

/** 状态徽标（列表 / 表单用短词，不写句子） */
export const CORS_VERDICT_LABEL: Record<CorsVerdict, string> = {
  pass: '网页可用',
  blocked: '网页被跨域拦下',
  'not-run': '网页未验证',
  'not-applicable': '网页不支持',
}

/** 台账取证日期（改结论时一起改，别让作者以为是最新的） */
export const PROTOCOL_WEB_CORS_CHECKED_AT = '2026-11-07'

/**
 * 表单里的说明句；`''` ＝ 不需要提示（例如桌面 / 便携版，或已确认通过的协议）。
 *
 * 纯函数：`web` 由调用方传入，方便单测覆盖两种形态（平台标志是模块求值时注入的常量）。
 */
export function webProtocolCorsNote(web: boolean, protocol: WireProtocol): string {
  if (!web) return ''
  const verdict = PROTOCOL_WEB_CORS[protocol]
  if (verdict === 'pass') return ''
  if (verdict === 'not-applicable') {
    return '网页版不连接本机 / 局域网端点（产品策略），这条配置在网页版不会被使用。'
  }
  if (verdict === 'blocked') {
    return `网页版是浏览器直连厂商：该协议的跨域（CORS）预检在本版已被拦下（核对日期 ${PROTOCOL_WEB_CORS_CHECKED_AT}）。`
      + '请改用桌面版 / 便携版，或换一个网页形态可用的联网平台。'
  }
  return '网页版是浏览器直连厂商：该协议的跨域（CORS）预检本版尚未取得通过结论'
    + `（核对日期 ${PROTOCOL_WEB_CORS_CHECKED_AT}），可能连不上 —— 失败时会提示「无法连接 / 跨域」，不代表密钥或模型名写错。`
    + '密钥由你自备，且在浏览器请求头里可见。'
}

/** 运行形态下的台账徽标（桌面 / 便携版返回 `''`，界面不显示这一项） */
export function webProtocolCorsBadge(protocol: WireProtocol): string {
  if (!WEB) return ''
  return CORS_VERDICT_LABEL[PROTOCOL_WEB_CORS[protocol]]
}
