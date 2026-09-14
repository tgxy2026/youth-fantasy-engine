/**
 * 酒馆模式 · 消息渲染（剧情推演与自由对话共用）
 *
 * 按协议 O1 的格式规定做**最朴素**的样式区分：
 *   · 动作（全角括号包裹）→ 淡色小字
 *   · 内心（〔〕包裹）    → 淡色斜体
 *   · 其余（对白）        → 正常正文
 *
 * 方案 §5.2 允许多样化，但明确「v1 先朴素标记，解析可靠后再上样式」——
 * 所以这里刻意不做富文本解析：协议里那些标记一旦被误解析，正文就会缺字，
 * 那比样式好看重要得多。
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
      if (t.startsWith('〔')) {
        return <div key={i} className="text-[12.5px] italic text-ink-400">{t}</div>
      }
      return <div key={i} className="text-[13px] leading-relaxed text-ink-100">{t}</div>
    })
}

export default renderTavernMessage
