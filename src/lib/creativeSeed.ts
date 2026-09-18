/**
 * 「创意写作」想法引导的纲 —— 把「一句话想法」升级成「聊出来的想法」。
 *
 * 【为什么要它】
 * 一句话想法适合**已经想清楚**的作者；原创开局往往是"有点感觉，说不清"。
 * 这时需要的不是憋出一句完整描述，而是被问着走：先定题材与基调，再问主角，再问冲突……
 *
 * 【为什么这里只写"纲"】
 * 访谈逻辑（一次只问 1–3 个相关问题、字段白名单、增量合并 `filled`）全在通用核心 `interview.ts`，
 * 界面在 `InterviewChat.tsx`，两边都已服务角色卡 / 剧本 / 表单 / 表格。**别在这里再写一份** ——
 * 提问规则一旦有两份实现就一定会漂移。
 * 本文件只提供业务专属的两样东西：① 问什么（`CREATIVE_SEED_SPEC`）② 聊完怎么变回想法（`seedFromFilled`）。
 *
 * 【话题顺序的取舍】
 * 按"越聊越聚焦"排：先题材基调（定调性）→ 主角（定人）→ 核心冲突（定戏）→ 世界与风格（定壳）。
 * 反过来的话，第一轮就问世界观，作者会被问懵 —— 他还不知道自己想写什么类型的故事。
 */
import { filledToText, type InterviewSpec } from './interview'

/** 八个栏位 —— 既是要问出来的东西，也是模型的字段白名单（写别的会被丢掉） */
export const CREATIVE_SEED_SPEC: InterviewSpec = {
  subject: '创作想法',
  topics: [
    {
      key: 'genre',
      label: '题材与基调',
      ask: '想写什么类型的故事（玄幻 / 都市 / 悬疑 / 科幻…），以及整体的调性与爽感取向（热血、冷厉克制、轻松诙谐…）',
      fields: ['genre', 'tone'],
    },
    {
      key: 'hero',
      label: '主角',
      ask: '主角是谁（身份、起点处境、最鲜明的特质），以及他最想要什么、为什么非得到不可',
      fields: ['protagonist', 'goal'],
    },
    {
      key: 'conflict',
      label: '核心冲突',
      ask: '挡在主角面前的是什么（对手、规则、自身缺陷），以及失败会付出什么代价',
      fields: ['conflict', 'stakes'],
    },
    {
      key: 'shell',
      label: '世界与风格',
      ask: '故事发生在什么样的世界（力量体系 / 时代底色 / 主要舞台），以及希望的文风与节奏（章节长度、单章信息量）',
      fields: ['world', 'style'],
    },
  ],
  allowedKeys: ['genre', 'tone', 'protagonist', 'goal', 'conflict', 'stakes', 'world', 'style'],
  labels: {
    genre: '题材类型',
    tone: '整体基调',
    protagonist: '主角是谁',
    goal: '主角想要什么',
    conflict: '核心冲突',
    stakes: '失败代价',
    world: '世界设定',
    style: '文风与节奏',
  },
}

/**
 * 把引导过程中收集到的栏位拼成「一句话想法」。
 *
 * 用**带标签的多行**而不是人话长段：这段文本会填回输入框给作者过目、逐行改，
 * 标签让"哪句对应哪栏"一眼可查；灌进模型时它也照样读得懂（设定奠基的提示词本就是按栏解读的）。
 * 空栏直接不出现 —— 留一堆"（未填）"反而污染提示词。
 */
export function seedFromFilled(filled: Record<string, string>): string {
  return filledToText(filled, CREATIVE_SEED_SPEC.labels).trim()
}
