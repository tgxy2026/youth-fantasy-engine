/**
 * 结构模板库（2.5.0 · A1）—— 把权威叙事结构做成「可填空的脚手架」。
 *
 * 来源背景：竞品调研《docs/2.5.0-竞品调研-故事织机StoryPlotter.md》——对方把 15+ 本编剧书
 * 方法论产品化是其口碑核心；我们补上这一层，但**内容全部自撰**：
 *
 * 🔴🔴 版权红线：节拍**名称**与**占比区间**属于通用方法论事实（不受版权保护），
 *    但每拍的 `brief`（定义）与 `ask`（引导问题）都是本文件**自撰的中文文案**，
 *    绝不搬运任何书籍原文，也绝不抓取任何竞品产品的模板内容库。
 *
 * 🔴 数据形态：内置静态数据，**不进项目库**（不占 schema、不走迁移、不参与同步）；
 *    作者「选了哪套」由创意写作的输入态持久化（`creativeSession.CreativeInputs.structureId`，
 *    `''` = 不使用）——本模块保持纯数据，**不碰 db**，避免出现两个存储来源。
 *
 * 消费方：
 *   - 创意写作 · 大纲规划（`aiTasks/creative.ts` 的 `planOutlineSys`）：选了模板时把
 *     `formatStructureHint` 的产物注入提示词当骨架约束（缺口补齐模式不注入）；
 *   - 情节推演画布（`PlotCanvas.tsx`）：「按模板铺节点」一键铺出节拍卡片（纯本地，零 AI）。
 */

/** 封闭的模板 id 枚举 —— 新增模板只改这里 + `STORY_TEMPLATES`，消费端一律走 `getStoryTemplate` */
export type StoryTemplateId = 'three-act' | 'stc-15' | 'qi-cheng-zhuan-he' | 'webnovel-volumes'

/** 一个结构节拍：`from`/`to` 为全书百分比（0 ~ 100，`to` > `from`，首拍 `from`=0、末拍 `to`=100） */
export interface StoryBeat {
  name: string
  from: number
  to: number
  /** 一句话定义：这一拍在故事里干什么 */
  brief: string
  /** 引导问题：作者填这一拍时问自己的一句关键话 */
  ask: string
}

export interface StoryTemplate {
  id: StoryTemplateId
  name: string
  /** 适用场景说明（下拉里的一句话提示） */
  genre: string
  beats: StoryBeat[]
}

export const STORY_TEMPLATES: StoryTemplate[] = [
  {
    id: 'three-act',
    name: '三幕式',
    genre: '通用性最强：短篇、单卷、节奏干净的故事',
    beats: [
      {
        name: '建置', from: 0, to: 25,
        brief: '把主角、世界与日常立起来，埋下即将打破这一切的种子',
        ask: '读者看完这一段，能不能说出「主角是谁、他想要什么、什么在拦着他」？',
      },
      {
        name: '对抗', from: 25, to: 75,
        brief: '冲突层层加码：每次胜利都带出新麻烦，主角在代价中被迫成长',
        ask: '中段最容易出现「原地打转」——每个新麻烦有没有真的比上一个更难？',
      },
      {
        name: '解决', from: 75, to: 100,
        brief: '正面迎击最核心的冲突，收束主线，兑现或颠覆开头的期待',
        ask: '终局用的能力与答案，前文是否已经埋好？避免临空掉下解法。',
      },
    ],
  },
  {
    id: 'stc-15',
    name: '十五拍结构',
    genre: '节拍定位最细：适合想精确控制全书推进点的作者',
    // 节拍名为通用方法论词汇；占比为公知口径；brief / ask 为本项目自撰。
    beats: [
      { name: '开场画面', from: 0, to: 1, brief: '用一组镜头给出主角世界的「改造前」快照', ask: '这个画面与结尾能否形成一眼可见的对照？' },
      { name: '主题呈现', from: 1, to: 5, brief: '借他人之口点出主角尚未听懂的那句话', ask: '这句话是否要在结局被主角重新理解？' },
      { name: '铺垫', from: 5, to: 10, brief: '展示主角的缺陷、牵挂与「需要改变而未改变」的状态', ask: '每条铺垫是否都能在后面找到回收点？' },
      { name: '催化剂', from: 10, to: 12, brief: '一记无法忽视的事件把日常砸出裂缝', ask: '这件事是否大到让主角回不去原来的生活？' },
      { name: '争执', from: 12, to: 20, brief: '主角犹豫、挣扎、权衡代价，迟迟不肯上路', ask: '犹豫的理由是否站得住，而不是单纯拖延？' },
      { name: '进入第二幕', from: 20, to: 22, brief: '主角主动做出选择，跨进陌生的世界', ask: '这一步是主角「自己选的」吗？被动推进会显得弱。' },
      { name: '副线开启', from: 22, to: 25, brief: '引入承担主题的另一条关系线', ask: '这条副线与主线是否在终局汇合？' },
      { name: '游戏时光', from: 25, to: 50, brief: '兑现题材承诺：读者为这个设定而来的看点密集上演', ask: '这一段是否是全书「爽点 / 看点」最密集的部分？' },
      { name: '中点', from: 50, to: 52, brief: '一次假胜利或假失败，把 stakes 明显抬高', ask: '中点之后，故事的游戏规则变了吗？' },
      { name: '敌人逼近', from: 52, to: 75, brief: '外压升级、内隙扩大，中点赢得的东西开始崩解', ask: '危机是内外两线同时收紧的吗？' },
      { name: '一无所有', from: 75, to: 78, brief: '全书最低谷：失去不可挽回的人或物', ask: '这个「失去」是否早有感情铺垫？' },
      { name: '灵魂黑夜', from: 78, to: 80, brief: '主角直面深渊，消化失败，完成认知翻面', ask: '主角想通了的那件事，是否正是主题呈现那句话？' },
      { name: '进入第三幕', from: 80, to: 82, brief: '综合主线与副线的答案，拿出全新的解法', ask: '新解法为何以前行不通、现在行得通？' },
      { name: '结局', from: 82, to: 99, brief: '压上全部筹码的最终对决与逐线收束', ask: '每条伏笔都有归宿了吗？' },
      { name: '终场画面', from: 99, to: 100, brief: '与开场画面成对照的「改造后」快照', ask: '不用一句话解释，读者能否看出主角变了？' },
    ],
  },
  {
    id: 'qi-cheng-zhuan-he',
    name: '起承转合',
    genre: '最轻量的四段口径：大纲阶段快速对齐节奏',
    beats: [
      {
        name: '起', from: 0, to: 20,
        brief: '确立人物与情境，把阅读期待立起来',
        ask: '读者被什么勾住？前三章内有没有一个非往下翻不可的理由？',
      },
      {
        name: '承', from: 20, to: 50,
        brief: '顺势展开：线索铺陈、关系加深、矛盾在暗中累积',
        ask: '表面平稳之下，是否有一根持续拧紧的发条？',
      },
      {
        name: '转', from: 50, to: 75,
        brief: '一次真正打破格局的转折，把故事推进深水区',
        ask: '转折是否改变了「谁需要什么」？只换场景不算转。',
      },
      {
        name: '合', from: 75, to: 100,
        brief: '收束线索、落定冲突，留下余韵或新钩子',
        ask: '收束的节奏是否够稳？连载作品要考虑下一卷从哪里重新起势。',
      },
    ],
  },
  {
    id: 'webnovel-volumes',
    name: '网文三卷式',
    genre: '网文连载口径：黄金三章 + 卷末大高潮',
    beats: [
      {
        name: '第一卷 · 立足', from: 0, to: 30,
        brief: '黄金三章：金手指亮相、立住人设、首个小高潮尽早兑现；主角在基层舞台站稳脚跟',
        ask: '第一章能不能让读者记住「主角凭什么能赢」？',
      },
      {
        name: '第二卷 · 崛起', from: 30, to: 70,
        brief: '舞台升级、对手变强，爽点密度与代价同步抬升；中段安排一次像样的大挫折防止顺水顺风',
        ask: '主角的每次胜利是否都付出了看得见的代价？',
      },
      {
        name: '第三卷 · 登顶', from: 70, to: 100,
        brief: '终极对手登场，多线收束，最后一战兑现全书最大的期待感',
        ask: '终局的赌注是否是全书最高？此前的每条线是否都被这一战收割？',
      },
    ],
  },
]

/** 按 id 取模板；id 不合法（含 undefined / 老数据脏值）一律返回 null —— 消费端按「未选择」处理 */
export function getStoryTemplate(id: unknown): StoryTemplate | null {
  if (typeof id !== 'string') return null
  return STORY_TEMPLATES.find(t => t.id === id) ?? null
}

/**
 * 把模板压成大纲提示词用的「结构参考」文本（控制体量：4 套中最长的 15 拍 ≈ 700 字）。
 * 🔴 口径是**全书**百分比：由调用方在提示词里说明「按总章数折算」，本函数只出数据。
 */
export function formatStructureHint(t: StoryTemplate): string {
  const lines = t.beats.map(b => `· ${b.name}（${b.from}%-${b.to}%）：${b.brief}`)
  return `【全书结构参考 · ${t.name}】\n` +
    '章节事件的整体推进请大致贴合以下节拍（按全书总章数折算位置），允许有机穿插、允许一拍占多章，不要机械对齐：\n' +
    lines.join('\n')
}
