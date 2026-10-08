/**
 * 「这几个参数在当前的模型上**不生效**」的灰显占位（2026-10-09 抽为一处）。
 *
 * 为什么抽出来：同一段「— ＋ 说明」此前在 3 个文件各写一遍 ——
 *   模型配置的「文本生成微调」/ 酒馆的 Ollama 专有采样参数 / 酒馆的「上下文窗口长度」。
 *   而它们的判据必须**同源**（都在问"这台服务认不认 Ollama 原生参数"），
 *   分开写就会出现「一处改了判据、另两处没跟上」的漂移。
 *
 * 🔴 判据见 `lib/modelSampling.ts#isOllamaSamplingChannel`：是 `type === 'ollama'`，
 *    **不是** `local` —— 本地 OpenAI 兼容服务（LM Studio / LocalAI / GPT4All / Jan…）也是「本地」，
 *    但它走 openaiChat 的白名单，`top_k` / `repeat_penalty` / `repeat_last_n` 会被静默丢弃。
 *    （2026-10-09 六维审计发现：起先三处都按 `local` 判，本地 OpenAI 兼容模型下会
 *      「界面可编辑、下发却无效」—— 正是本轮要修的那类问题。）
 */
export default function SamplingUnavailable({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-1.5 ${className}`}>
      <span className="text-12 text-ink-600">—</span>
      <span className="text-10 text-ink-600">只对本地 Ollama 生效</span>
    </div>
  )
}
