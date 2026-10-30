// ============ 内置使用手册 · 门面（3.3.1 · P1） ============
//
// 外部一律从这里取手册能力：`import { searchHelp, HELP_ARTICLES } from '@/lib/help'`。
// 🔴 与 `lib/schema.ts` 同一条纪律：**显式再导出，禁 `export *`** —— 免得内部实现被顺手当接口用。
// 🔴 本目录只依赖 `lib/schema`（取页签 id 做校验）与自身内容，**不 import components**（分层红线）。
export type {
  HelpAction,
  HelpAiRequirement,
  HelpArticle,
  HelpAvailability,
  HelpGroup,
  HelpHit,
  HelpIndexEntry,
  HelpSection,
} from '@/lib/help/types'

export {
  ALL_TAB_IDS,
  CONTENT_VERSION,
  HELP_ARTICLES,
  HELP_GROUPS,
  HELP_INDEX,
  SUPPORTED_APP_VERSION,
  buildHelpIndex,
  checkHelpContent,
  coveredTabIds,
  getHelpArticle,
  helpArticlesForTab,
  helpArticlesInGroup,
  isHelpContentConsistent,
  tabsWithoutHelp,
} from '@/lib/help/registry'
export type { HelpContentIssue } from '@/lib/help/registry'

export {
  HELP_BUILD_ID,
  HELP_BUILD_META,
  HELP_BUILD_MISMATCH_NOTICE,
  HELP_RELOAD_LABEL,
  checkHelpBuild,
  readShellBuildId,
} from '@/lib/help/buildInfo'
export type { HelpBuildState } from '@/lib/help/buildInfo'

export {
  MAX_HITS,
  MAX_HITS_PER_ARTICLE,
  MIN_HIT_SCORE,
  buildHelpExcerpt,
  normalizeHelpText,
  searchHelp,
  suggestHelpGroups,
  tokenizeHelpQuery,
} from '@/lib/help/search'

// 连续追问的参考主题（规划 §5.5）：判据与措辞都在这里，界面不自己另写一份
export {
  ASK_CLARIFY_TEXT,
  MAX_TOPIC_ANSWER,
  SELF_TOPIC_SCORE,
  buildThreadContextLine,
  buildTopicQuery,
  hasStrongAnaphora,
  looksLikeFollowUp,
  routeAskRecall,
  topicFromAnswer,
} from '@/lib/help/thread'
export type { AskRecall, AskTopic, AskTopicOption } from '@/lib/help/thread'
