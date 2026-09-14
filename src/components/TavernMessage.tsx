/**
 * 酒馆模式 · 消息渲染（剧情推演与自由对话共用）
 *
 * 按协议 O1（v1.3）的格式规定做**最朴素**的样式区分 —— 每行以哪个符号开头，就决定它是什么：
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
 *
 * 🔴 「哪一行算什么」不再写在这里，改调 `tavern/exportDoc` 的 `classifyTavernLine` ——
 *    导出文档（B5）也要按同一套规则分行，判定规则散成两份必然漂移（本项目反复踩过的坑）。
 *    这里只负责**样式映射**。
 */
import { classifyTavernLine, type TavernLineKind } from '../lib/tavern/exportDoc'

const KIND_CLASS: Record<TavernLineKind, string> = {
  action: 'text-[12px] text-ink-400',
  ambient: 'text-[12px] italic text-ink-500',
  state: 'text-[12.5px] italic text-ink-400',
  speech: 'text-[13px] leading-relaxed text-ink-100',
}

export function renderTavernMessage(content: string) {
  return String(content ?? '')
    .split('\n')
    .filter(l => l.trim())
    .map((line, i) => {
      const t = line.trim()
      return <div key={i} className={KIND_CLASS[classifyTavernLine(t)]}>{t}</div>
    })
}

export default renderTavernMessage
