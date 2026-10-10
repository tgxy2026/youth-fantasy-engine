// ============ 「AI 辅助规划」的功能提示词（W2-3 · 自组件搬进 lib）============
//
// 🔴 为什么必须放在 lib 而不是组件里（2026-10-10 · W2-3 抓到的真缺口）：
//   `registerPrompt` 原先写在 `components/AIAssist.tsx` 文件末尾，而 `AIAssist` 只被
//   `components/InspireTools.tsx` import，**`InspireTools` 在 `App.tsx` 里是 `lazy()` 懒加载** ——
//   于是「从没打开过【灵感工具】页」的作者，在「模型设置 → AI 提示词」里**根本看不到这条**
//   （`listPrompts()` 里压根没有它）。提示词注册必须落在**静态可达**的路径上。
//   本模块由 `src/lib/ai.ts` 静态 import（与 `aiCore/prompts` 同款做法）⇒
//   不论作者打开过哪个页签，这条一定在册。
//
// 提示词文本**逐字搬运**（本节只动「注册位置」，不改一个字）。
import { registerPrompt } from '@/lib/promptSettings'

let SYSTEM_PROMPT = `你是一位网络小说创作的辅助助手，专门帮助作者做创作前期的「灵感激发、剧情 / 人物 / 世界观规划、设定脑暴、一致性自查」工作。

规则：
1. 只输出规划性、启发性的内容（创意、大纲草案、设定建议、可选项），不要替作者直接写出小说正文章节；
2. 结构清晰，善用标题、列表、分点，便于作者直接取用；
3. 贴合作者给定的题材与风格；
4. 若信息不足，主动给出多个可选项而非空泛回答；
5. 用简体中文回复；
6. 若对话中提供了【项目资料】（世界观 / 角色 / 时间线 / 势力等），请优先参考其中已填写的设定，使建议贴合已有世界观与人设、不与已登记设定冲突，并可主动呼应其中的伏笔与线索。`

/** 读当前生效文本（可能被作者在「AI 提示词」里改过） */
export function getAssistPrompt(): string {
  return SYSTEM_PROMPT
}

// —— 提示词登记（本模块加载即注册；🔴 不要挪回组件里）——
registerPrompt(
  { id: 'assist-planner', group: '灵感工具', name: 'AI 辅助规划', note: '多轮对话式脑暴，结合项目设定给创作建议。' },
  () => SYSTEM_PROMPT,
  t => { SYSTEM_PROMPT = t },
)
