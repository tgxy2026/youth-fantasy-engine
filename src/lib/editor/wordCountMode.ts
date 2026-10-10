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
 *
 * ## 覆盖位盘点结论（2.5.2 · A1，2026-09-26）
 * 已覆盖：编辑器底部状态位、数据看板统计卡与码字日历。
 * 评估后**不接入**的展示位（别再重复提案）：
 * · 快照 / 回收站字数（EditorModals）—— 历史快照的字数本该是**当时的落库口径**，快照不可变；
 * · AI 整理候选列表（AIOrganize）—— 那是表格行的登记字数，不是章节正文，口径不适用；
 * · 章节树 / 全文搜索选择器（NovelEditorChapterTree / ChapterPicker）—— 长列表实时重算
 *   全文正则扫描成本高，且树里的字数是「落库快照」性质；性价比不足，保持落库值。
 * 若将来要给树接实时口径，先解决「滚动中每章全文扫描」的性能账再动。
 */
import { usePersistedBool } from '@/lib/settings/uiPrefs'
import type { WordCountMode } from '@/lib/editor/textStats'

/** 偏好 key（落在 `yfe-ui:` 命名空间 —— 本机偏好、不进项目数据、不随导出 / 云同步走） */
const WORD_COUNT_PUNCT_KEY = 'word-count-with-punct'

/**
 * 字数口径偏好。
 * @returns `[withPunct, setWithPunct]` —— false＝只算汉字（默认 / 老口径）；true＝汉字＋标点（平台计费口径）
 */
export function useWordCountWithPunct(): [boolean, (v: boolean) => void] {
  return usePersistedBool(WORD_COUNT_PUNCT_KEY, false)
}

/** 当前偏好对应的 `countWords` 模式参数 */
export function wordCountModeOf(withPunct: boolean): WordCountMode {
  return withPunct ? 'cjk-punct' : 'cjk'
}
