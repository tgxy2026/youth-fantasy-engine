/**
 * 酒馆模式 · 消息渲染（剧情推演与自由对话共用）
 *
 * 按协议 O1（v1.2）的格式规定做**最朴素**的样式区分 —— 每行以哪个符号开头，就决定它是什么：
 *   · （ ） 动作、神态、心理   → 淡色小字
 *   · 【 】 客观环境与人物外在 → 更淡的斜体（它是给这一幕定调的背景，不该抢对白）
 *   · 〔 〕 状态块             → 淡色斜体
 *   · 其余  对白               → 正常正文
 *
 * 为什么只按行首符号判断、不做富文本解析：标记一旦被误解析，正文就会缺字 ——
 * 那比样式好看重要得多。带标记的行**原样显示**（含符号），作者能自己核对格式。
 *
 * 抽成共享件是为了让两条线用**同一套**渲染 —— 两处各写一份必然慢慢漂移
 * （改了剧情推演的样式、自由对话还是旧的）。
 */
export function renderTavernMessage(content: string) {
  return String(content ?? '')
    .split('\n')
    .filter(l => l.trim())
    .map((line, i) => {
      const t = line.trim()
      if (t.startsWith('（') || t.startsWith('(')) {
        return <div key={i} className="text-[12px] text-ink-400">{t}</div>
      }
      if (t.startsWith('【')) {
        return <div key={i} className="text-[12px] italic text-ink-500">{t}</div>
      }
      if (t.startsWith('〔')) {
        return <div key={i} className="text-[12.5px] italic text-ink-400">{t}</div>
      }
      return <div key={i} className="text-[13px] leading-relaxed text-ink-100">{t}</div>
    })
}

export default renderTavernMessage
