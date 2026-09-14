/**
 * 控制面板 · 数值项的「取值范围 + 分段影响」
 *
 * 【为什么单独一份】
 * 以前每个输入框旁边只有一句「通常 1.05」—— 用户知道了默认值，却不知道**这一段意味着什么**，
 * 想按自己的需求微调时无从下手（老大的原话：说明比较简陋）。这里把每个参数切成若干段，
 * 写清**每一段对模型输入输出的影响**，界面上高亮当前值所在的那一段。
 *
 * 【它同时是 min/max/step/unit 的唯一真源】
 * 输入框从这份表取范围，不再在 JSX 里各写一份 —— 否则「说明里写的范围」和「输入框实际允许的范围」
 * 迟早对不上，而**说明写错比没写更坏**。`tests/paramGuide.test.ts` 会锁住：
 * 分段必须首尾相接、无空隙无重叠、完整覆盖 [min,max]，且恰好有一个推荐段。
 *
 * 【分段判定的口径】
 * `bandOf()` 取「第一个 `to >= v` 的段」—— 段是升序且首尾相接的，所以
 * **边界值（正好等于某段上界）归下面那一段**：温度 0.7 高亮「保守」、1.1 高亮「平衡」。
 * 这与直觉一致（处在某段最上沿的值，性质仍属那一段），也免得「越调越飘」的错觉。
 * 表里显示的范围两端都是闭区间，所以边界值在两行里都合理出现，高亮取靠下的那一段。
 * `from === to` 的段（如 topK 的「关闭」）只在 v 正好等于它时命中。
 *
 * 【写文案的三条纪律】
 *  ① 说**影响**，不说好坏：「措辞高度可预测，很少出意外」优于「效果更好」；
 *  ② 一段话讲清**输入→输出**的因果关系（温度高 → 采样面变宽 → 会跑题），别只给形容词；
 *  ③ 端点段要写得**极端**，因为用户真的会拉到端点 —— 那时应该明确告诉他「不要进这一段」。
 *
 * 本文件纯数据 + 纯函数，不含 React，也不引任何运行时依赖。
 */

/** 一个数值区间段 */
export type ParamBand = {
  /** 段下界（含） */
  from: number
  /** 段上界（含）；等于 from 表示这是个「单点段」（如 topK=0 的「关闭」） */
  to: number
  /** 2~4 字档名，用于一眼扫过 */
  name: string
  /** 这一段对模型输入输出的影响（说因果，别说好坏） */
  effect: string
  /** 内置默认值落在这一段。每个 guide **恰好**一个 */
  recommended?: boolean
}

export type ParamGuide = {
  min: number
  max: number
  step: number
  /** 单位（显示在标题括号里）；无单位留空 */
  unit?: string
  bands: ParamBand[]
}

/** 采样类参数：剧情推演与自由对话**语义完全相同**，共用一份（差异写在各自那条 hint 里） */
export const GUIDE_TEMPERATURE: ParamGuide = {
  min: 0, max: 2, step: 0.05,
  bands: [
    { from: 0, to: 0.4, name: '死板', effect: '几乎每次都给同一个回答，角色像在念设定稿 —— 措辞不变，同一句话总是同样的反应。只在「必须严格照设定走、不许发挥」时用。' },
    { from: 0.4, to: 0.7, name: '保守', effect: '措辞有变化，但走向高度可预测，角色很稳、很少出意外。适合信息量大、要严谨推进的场合（复盘、对质）。' },
    { from: 0.7, to: 1.1, name: '平衡', effect: '角色一致性还在，同时会冒出意料之外的细节与转折 —— 推演要的「像活人」就在这一段。', recommended: true },
    { from: 1.1, to: 1.5, name: '活跃', effect: '转折多、脑洞多，代价是开始人设漂移：语气变了、自称变了、忘了刚说过的话。' },
    { from: 1.5, to: 2, name: '放飞', effect: '接近随机抽样，常出现语句破碎、前后矛盾、突然换人称。只在故意要「醉酒 / 发疯」效果时进这一段。' },
  ],
}

export const GUIDE_TOP_P: ParamGuide = {
  min: 0, max: 1, step: 0.01,
  bands: [
    { from: 0, to: 0.2, name: '掐死长尾', effect: '每步只从最可能的一两个词里挑，回复极度重复模板化（「嗯。」「好。」），几乎没有新的表达方式。' },
    { from: 0.2, to: 0.5, name: '保守', effect: '用词保守但句子还算自然；长句、生僻说法基本不会出现。' },
    { from: 0.5, to: 0.8, name: '偏保守', effect: '表达比上一段丰富，仍以常见词为主，很少出人意料。' },
    { from: 0.8, to: 0.95, name: '平衡', effect: '保留绝大多数自然表达，只切掉最离谱的尾部，是通用推荐区。', recommended: true },
    { from: 0.95, to: 1, name: '不过滤', effect: '长尾词全进来，用词更花哨，也更容易出现别扭搭配、错别字与突兀的书面语。' },
  ],
}

export const GUIDE_TOP_K: ParamGuide = {
  min: 0, max: 200, step: 1,
  bands: [
    { from: 0, to: 0, name: '关闭', effect: '不做这一步筛选，候选完全交给温度和核采样决定 —— 范围最宽，也最难预料。' },
    { from: 1, to: 20, name: '极窄', effect: '候选极少，回复高度稳定、词汇贫乏；一旦要写长段落，很快就开始复读。' },
    { from: 20, to: 60, name: '平衡', effect: '主流区间：压住离谱用词，同时留够表达空间，中文角色扮演通常够用。', recommended: true },
    { from: 60, to: 120, name: '放开', effect: '允许更少见的词，文风更活；本地小模型容易因此跑出病句与生造词。' },
    { from: 120, to: 200, name: '几乎不限', effect: '等价于关掉 topK，却比「关」更难预料 —— 因为下限仍然挂着、上限失去了约束。' },
  ],
}

export const GUIDE_REPEAT_PENALTY: ParamGuide = {
  min: 0.5, max: 2, step: 0.01,
  bands: [
    { from: 0.5, to: 1, name: '鼓励重复', effect: '低于 1 等于**奖励**重复用词 —— 口头禅、整句复读都会明显变多。只有想强化「这个人就爱说这句」时才用。' },
    { from: 1, to: 1.1, name: '极轻', effect: '1 等于不惩罚；1.05 左右只轻微压住复读，几乎不影响正常表达。', recommended: true },
    { from: 1.1, to: 1.35, name: '明显', effect: '复读显著减少，但模型开始刻意换词 —— 同一个东西换着法儿叫（烟 / 香烟 / 烟卷），偶尔换得别扭。' },
    { from: 1.35, to: 1.7, name: '过强', effect: '连「的、了、他」这类高频虚词都会被回避，句子变生硬、绕口，甚至不成句。' },
    { from: 1.7, to: 2, name: '破坏性', effect: '输出质量断崖式下降（用词错乱、语法崩坏）。除非在做对照实验，不要进这一段。' },
  ],
}

export const GUIDE_PRESENCE_PENALTY: ParamGuide = {
  min: -2, max: 2, step: 0.05,
  bands: [
    { from: -2, to: -1, name: '死守老话题', effect: '强烈倾向重复出现过的话题与用词 —— 对话明显绕圈，角色会反复问同一件事。' },
    { from: -1, to: -0.3, name: '黏着当前', effect: '愿意顺着现有话题往深里挖，很少主动开新线索。适合要把一件事聊透。' },
    { from: -0.3, to: 0.3, name: '无影响', effect: '既不追新也不守旧，有没有新话题完全交给温度和上下文决定。' },
    { from: 0.3, to: 0.8, name: '愿意开新话题', effect: '会主动带出新细节、新物件、新人物 —— 日常陪伴靠它才有「日子在往前走」的感觉。', recommended: true },
    { from: 0.8, to: 2, name: '频繁跳话题', effect: '一段里塞进好几个新话题，容易丢掉上一句的线索，长对话显得跳跃、接不上。' },
  ],
}

export const GUIDE_SETTING_RATIO: ParamGuide = {
  min: 10, max: 95, step: 5, unit: '%',
  bands: [
    { from: 10, to: 35, name: '历史优先', effect: '设定被大幅压缩，项目资料只能带进一小部分 —— 角色容易「忘设定」（性格、口癖、关系都可能走样）。' },
    { from: 35, to: 55, name: '偏历史', effect: '设定只保留最核心的部分。适合设定不重、但对话很长的场景。' },
    { from: 55, to: 70, name: '常规', effect: '设定与历史大致平衡：世界够清楚，也记得住前面聊过什么。', recommended: true },
    { from: 70, to: 85, name: '偏设定', effect: '项目资料完整带上，代价是对话能记住的轮次明显变少。' },
    { from: 85, to: 95, name: '设定优先', effect: '几乎全给设定，只适合「先让模型读懂世界、再开始聊」的开局，聊久了会失忆。' },
  ],
}

export const GUIDE_CONTEXT_BUDGET: ParamGuide = {
  min: 1000, max: 100000, step: 500, unit: '字',
  bands: [
    { from: 1000, to: 4000, name: '极小', effect: '只记得住最近几轮；协议 + 角色卡 + 背景设定本身就吃掉大半，角色会反复问已经答过的事。' },
    { from: 4000, to: 10000, name: '单场戏', effect: '短对话够用。但剧情推演的 system 常有 8000~10000 字，这一档几乎全被 system 占满 → 留给对话历史的额度接近 0。' },
    { from: 10000, to: 24000, name: '长线（默认 16000）', effect: 'system 与对话历史都够用，是「一场完整推演 + 记得住前文」的推荐区间。', recommended: true },
    { from: 24000, to: 100000, name: '超长', effect: '必须同时把「上下文窗口长度」调大，否则会被模型端截断；本地模型从这里开始明显变慢、显存吃紧。' },
  ],
}

export const GUIDE_FIXED_OVERHEAD: ParamGuide = {
  min: 0, max: 20000, step: 100, unit: '字',
  // 2026-09-14 语义变更：协议与记忆已经算在 system 里，不再重复预留，这一项降到纯余量。
  bands: [
    { from: 0, to: 200, name: '几乎不留', effect: '额度贴近真实可用值；模型端若比我们估的多吃一点，长对话里容易突然报超长。' },
    { from: 200, to: 1000, name: '常规余量（默认 400）', effect: '只当纯余量：覆盖各层标题与少量未计入 system 的内容。协议与记忆已算在 system 里，不再重复预留。', recommended: true },
    { from: 1000, to: 4000, name: '偏保守', effect: '每轮白扣一千字以上，可用的对话历史被无谓压缩。' },
    { from: 4000, to: 20000, name: '过大', effect: '历史额度被砍掉一大截 —— 长推演会「忽然失忆」，而且很难联想到是这个数造成的。' },
  ],
}

export const GUIDE_TIMEOUT: ParamGuide = {
  min: 10, max: 900, step: 10, unit: '秒',
  bands: [
    { from: 10, to: 30, name: '只够快模型', effect: '云端小模型勉强可用；本地模型几乎必然中途超时，表现为「每次都报错」。' },
    { from: 30, to: 120, name: '联网惯用', effect: '云端模型的常规区间，一般不碰这条线。' },
    { from: 120, to: 300, name: '本地模型', effect: '本地 7B~32B 的首字延迟常超过 10 秒，加上生成本身的时间需要这个量级。', recommended: true },
    { from: 300, to: 900, name: '很慢的模型', effect: '只有跑 70B 以上或 CPU 推理才需要；设太大时「真卡住」会变成「等很久」，出问题不容易察觉。' },
  ],
}

export const GUIDE_NUM_CTX: ParamGuide = {
  min: 2048, max: 131072, step: 1024, unit: '词元',
  bands: [
    { from: 2048, to: 4096, name: '小显存', effect: '8G 显存跑 7B 的安全区；中文大约 3000~6000 字，所以「上下文预算」要明显小于它。' },
    { from: 4096, to: 8192, name: '常规本地', effect: '12~16G 显存的常用档，也是本地 7B~14B 的舒适区。' },
    { from: 8192, to: 32768, name: '大显存', effect: '24G 以上显存可用；显存占用随它近似线性增长，调大一档就要多留一份余量。', recommended: true },
    { from: 32768, to: 131072, name: '服务器级', effect: '需要 48G+ 显存或量化后才可行；设得超过实际能承载的量，模型会直接加载失败。' },
  ],
}

export const GUIDE_TRIGGER_MESSAGES: ParamGuide = {
  min: 2, max: 50, step: 1, unit: '条',
  bands: [
    { from: 2, to: 5, name: '频繁', effect: '每聊几句就整理一次：反复调用模型（费时间），记忆被切得太碎，最后只剩结论、细节全丢。' },
    { from: 5, to: 12, name: '积极', effect: '整理及时，记忆里能留住最近发生的事。', recommended: true },
    { from: 12, to: 30, name: '从容', effect: '一次整理更多内容，记忆更成块、更像「一段经历」而不是流水账。' },
    { from: 30, to: 50, name: '很久才整理', effect: '期间新内容完全不进记忆；关掉软件再打开时，这段时间发生的事可能没被记下。' },
  ],
}

export const GUIDE_SOFT_LIMIT: ParamGuide = {
  min: 200, max: 10000, step: 100, unit: '字',
  bands: [
    { from: 200, to: 800, name: '很紧', effect: '会频繁提醒超限、逼你去压缩，细小情节基本存不住。' },
    { from: 800, to: 2000, name: '常规', effect: '够放下六栏的要点，也不会和对话历史抢太多上下文。', recommended: true },
    { from: 2000, to: 5000, name: '宽松', effect: '细节更全，代价是每轮都多占上下文 —— 它和「上下文预算」是此消彼长的。' },
    { from: 5000, to: 10000, name: '很大', effect: '单是记忆就能吃掉大半上下文预算，模型会被设定挤满、顾不上对话历史。' },
  ],
}

export const GUIDE_HARD_LIMIT: ParamGuide = {
  min: 200, max: 20000, step: 100, unit: '字',
  bands: [
    { from: 200, to: 1200, name: '很紧', effect: '超过就压缩，日记与关系状态会被频繁砍短，长期看记忆会「越来越只剩骨架」。' },
    { from: 1200, to: 3000, name: '常规', effect: '在软上限之上留了一倍余量，够撑到下次整理。', recommended: true },
    { from: 3000, to: 8000, name: '宽松', effect: '长线陪伴（连着几个月）才需要；日常对话到这个量级说明该清一清了。' },
    { from: 8000, to: 20000, name: '很大', effect: '单是记忆就接近或超过上下文预算，模型忙着记设定、记不住刚说过的话。' },
  ],
}

export const GUIDE_LONGTERM_LIMIT: ParamGuide = {
  min: 100, max: 2000, step: 50, unit: '字',
  bands: [
    { from: 100, to: 200, name: '极简', effect: '长期摘要只剩几句话，久远的事容易被压没，角色会「忘了你们怎么认识的」。' },
    { from: 200, to: 500, name: '常规', effect: '能留住一个「她记得的过去」的轮廓，也留得住压缩空间。', recommended: true },
    { from: 500, to: 1200, name: '详细', effect: '久远经历更完整；但它是超限时**最先**被砍的一栏，写太长意义有限。' },
    { from: 1200, to: 2000, name: '偏大', effect: '会明显挤占「关键事实」「未爆的雷」这两栏的空间 —— 那两栏才是不能丢的。' },
  ],
}

export const GUIDE_DIARY_KEEP: ParamGuide = {
  min: 1, max: 30, step: 1, unit: '条',
  bands: [
    { from: 1, to: 3, name: '只留最近', effect: '两三天前的日记就滚掉了，往前翻会发现「断档」。' },
    { from: 3, to: 8, name: '常规', effect: '一周左右的生活痕迹都在，够角色回忆「前两天」。', recommended: true },
    { from: 8, to: 20, name: '留得久', effect: '半个月到三周；占用随条数线性增长，每一条都是一小段文字。' },
    { from: 20, to: 30, name: '很多', effect: '几乎等于又存了一份近期剧情，会和「最近对话」重复占额度。' },
  ],
}

export const GUIDE_SUMMARY_INTERVAL: ParamGuide = {
  min: 0, max: 1440, step: 10, unit: '分钟',
  bands: [
    { from: 0, to: 5, name: '几乎不设限', effect: '只要攒够条数就整理，可能十几分钟里压缩两三次。' },
    { from: 5, to: 30, name: '常规', effect: '聊一阵才整理一次，比较省；手动点「立即整理」不受它限制。', recommended: true },
    { from: 30, to: 180, name: '偏安静', effect: '半小时到三小时才自动整理，期间记忆不更新，角色会「不知道刚发生的事」。' },
    { from: 180, to: 1440, name: '很久', effect: '基本等于关掉自动整理，只靠手动点「立即整理」—— 记得自己点。' },
  ],
}

export const GUIDE_SUMMARY_LOCK: ParamGuide = {
  min: 1, max: 1440, step: 10, unit: '分钟',
  bands: [
    { from: 1, to: 10, name: '太短', effect: '一次整理还没跑完锁就过期，另一个窗口可能抢走它 —— 两份结果互相覆盖。' },
    { from: 10, to: 60, name: '常规', effect: '够一次总结跑完（含慢的本地模型），崩了也能及时被接管。', recommended: true },
    { from: 60, to: 180, name: '偏长', effect: '上次整理中断后，要等一两个小时才能被重新接管。' },
    { from: 180, to: 1440, name: '很长', effect: '一旦中断，半天内都很难再自动整理 —— 只能靠重启或手动。' },
  ],
}

export const GUIDE_DAILY_ADVANCE: ParamGuide = {
  min: 1, max: 168, step: 1, unit: '小时',
  bands: [
    { from: 1, to: 4, name: '很勤', effect: '隔一两个小时就补一段「这几天的生活」，日常会被流水账填满、缺少「过了一阵子」的分量。' },
    { from: 4, to: 12, name: '常规', effect: '一天一两次，角色对「时间过去了」有感觉，也不至于刷屏。', recommended: true },
    { from: 12, to: 48, name: '说得上话', effect: '隔半天以上才补，每次都更像「这段时间过去了」，但要隔夜才看得到变化。' },
    { from: 48, to: 168, name: '久别', effect: '一周才推进一次，日常这条线基本只在大跳跃时出现。' },
  ],
}

export const GUIDE_DAILY_KEEP: ParamGuide = {
  min: 1, max: 30, step: 1, unit: '条',
  bands: [
    { from: 1, to: 3, name: '只留最近', effect: '往前翻两天就没了，日常看起来只有零碎的两笔。' },
    { from: 3, to: 8, name: '常规', effect: '一周内的生活痕迹都在，和「日记保留」的体量相当。', recommended: true },
    { from: 8, to: 20, name: '留得久', effect: '占用随条数增长，每条都是一小段文字，会和记忆抢上下文。' },
    { from: 20, to: 30, name: '很多', effect: '和「日记保留」功能重叠，注意别让两处重复占额度。' },
  ],
}

/**
 * 控制面板数值项的取值表（key 是「面板上的位置」，不是设置里的字段名）。
 *
 * 采样五项刻意共用同一份 —— 剧情与自由的**语义完全一样**，
 * 差别只在各自那条 hint 里的取值建议，不该因此写两份会漂移的表。
 */
/** 本场数值：多久请求一次增量 */
export const GUIDE_VAR_EVERY_TURNS: ParamGuide = {
  min: 1, max: 10, step: 1, unit: '轮',
  bands: [
    { from: 1, to: 2, name: '每轮都动', effect: '数值几乎每句都在变，看起来最连续；代价是每轮多一行输出、也多一份解析风险，小幅乱跳会明显（像随机数）。' },
    { from: 2, to: 4, name: '每 3 轮', effect: '变化有节奏、看得出走向，又不会把额度花在数字上。', recommended: true },
    { from: 4, to: 7, name: '5–6 轮', effect: '变化更慢更"沉"，适合慢节奏长谈；短场景里可能整场都没动过一次。' },
    { from: 7, to: 10, name: '很稀疏', effect: '一场对话结束可能都没更新过 —— 数值基本等于摆设，只剩你手改。' },
  ],
}

/** 本场数值：单次允许的最大变化幅度（给模型的刹车） */
export const GUIDE_VAR_MAX_STEP: ParamGuide = {
  min: 1, max: 30, step: 1, unit: '点',
  bands: [
    { from: 1, to: 3, name: '很保守', effect: '推进极慢：0–100 的刻度上要走很久才有感觉，适合"关系本来就稳"的长线陪伴。' },
    { from: 3, to: 8, name: '±5', effect: '一次小事件动 2–5 点，十几轮下来能看到明显位移 —— 变化跟得上剧情又不跳戏。', recommended: true },
    { from: 8, to: 15, name: '剧烈', effect: '一次大事件的量级；模型容易在每轮都判成"大事件"，数值几轮内就撞顶。' },
    { from: 15, to: 30, name: '近乎放开', effect: '基本等于不限制，数值会很快停在 0 或 100，之后再也不动 —— 还不如关掉这项。' },
  ],
}

/** 联网检索：每次取几条结果喂给模型 */
export const GUIDE_SEARCH_TOP_K: ParamGuide = {
  min: 1, max: 10, step: 1, unit: '条',
  bands: [
    { from: 1, to: 2, name: '1–2 条', effect: '只够确认「有没有这个东西」；信息面窄，模型仍要大量依赖自己的记忆。' },
    { from: 2, to: 6, name: '3–5 条', effect: '够看清一个题材的轮廓（人物设定 / 故事梗概 / 关键设定），也不会把上下文挤满。', recommended: true },
    { from: 6, to: 10, name: '6–10 条', effect: '细节更全（尤其冷门题材），但摘要里的重复与噪音也更多，起草时更容易被带偏。' },
  ],
}

export const PARAM_GUIDES = {
  // 通用设置
  contextBudget: GUIDE_CONTEXT_BUDGET,
  fixedOverheadChars: GUIDE_FIXED_OVERHEAD,
  timeoutSec: GUIDE_TIMEOUT,
  numCtx: GUIDE_NUM_CTX,
  // 剧情推演
  plotSettingRatio: GUIDE_SETTING_RATIO,
  // 自由对话（记忆与日常）
  triggerMessages: GUIDE_TRIGGER_MESSAGES,
  softLimit: GUIDE_SOFT_LIMIT,
  hardLimit: GUIDE_HARD_LIMIT,
  longTermLimit: GUIDE_LONGTERM_LIMIT,
  diaryKeep: GUIDE_DIARY_KEEP,
  summaryInterval: GUIDE_SUMMARY_INTERVAL,
  summaryLock: GUIDE_SUMMARY_LOCK,
  dailyAdvance: GUIDE_DAILY_ADVANCE,
  dailyKeep: GUIDE_DAILY_KEEP,
  // 本场数值（C2 第二步）
  varEveryTurns: GUIDE_VAR_EVERY_TURNS,
  varMaxStep: GUIDE_VAR_MAX_STEP,
  // 联网检索
  searchTopK: GUIDE_SEARCH_TOP_K,
} as const

/** 两个模式共用的采样参数（语义一致，故只有一份） */
export const GUIDE_SAMPLING = {
  temperature: GUIDE_TEMPERATURE,
  topP: GUIDE_TOP_P,
  topK: GUIDE_TOP_K,
  repeatPenalty: GUIDE_REPEAT_PENALTY,
  presencePenalty: GUIDE_PRESENCE_PENALTY,
} as const

/** 找出某个值落在哪一段。找不到（越界）时返回最后一段，调用方不必先夹取 */
export function bandOf(g: ParamGuide, v: number): ParamBand {
  return g.bands.find(b => v <= b.to) ?? g.bands[g.bands.length - 1]
}
