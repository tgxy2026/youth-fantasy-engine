/**
 * 字数口径偏好 —— **单一来源**。
 *
 * #004（2.4.0）引入两种口径：网文平台按「汉字＋标点」计费，而软件内部
 * （落库 `wordCount`、`enforceWordRange` 的 ±300、AI 输出阈值）**一律走老口径**，
 * 含标点只在**显示层**实时重算 —— 这样开关随时可逆、历史数据不会被打脏（见 textStats 说明）。
 *
 * 🔴 为什么单拎一个模块：这个偏好被 Dashboard（统计卡 / 码字日历）与编辑器状态栏两处读，
 *    各写一份 key 字符串必然漂移 —— 而漂移的表现是「在面板切了口径，编辑器却没跟着变」
 *    这种静默不一致，肉眼极难发现（本项目对这类「两处各写一份」有多次教训）。
 */
import { usePersistedBool } from './uiPrefs'
import type { WordCountMode } from './textStats'

/** 偏好 key（落在 `yfe-ui:` 命名空间 —— 本机偏好、不进项目数据、不随导出 / 云同步走） */
export const WORD_COUNT_PUNCT_KEY = 'word-count-with-punct'

/**
 * 字数口径偏好。
 * @returns `[withPunct, setWithPunct]` —— false＝只算汉字（默认 / 老口径）；true＝汉字＋标点（平台计费口径）
 */
export function useWordCountWithPunct(): [boolean, (v: boolean) => void] {
  return usePersistedBool(WORD_COUNT_PUNCT_KEY, false)
}

/** 当前口径的短标签（开关与工具提示共用同一份措辞，避免两处文案不一致） */
export function wordCountModeLabel(withPunct: boolean): string {
  return withPunct ? '汉字＋标点' : '只算汉字'
}

/** 当前偏好对应的 `countWords` 模式参数 */
export function wordCountModeOf(withPunct: boolean): WordCountMode {
  return withPunct ? 'cjk-punct' : 'cjk'
}
