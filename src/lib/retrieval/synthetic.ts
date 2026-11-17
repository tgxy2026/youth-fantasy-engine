/**
 * 材料检索验证（G）· 合成语料与标注查询
 *
 * 依据：规划 §9 / §16 G —— 「先用合成数据比较当前方案与轻量改进，验证短词、同名、
 * 跨章节、空结果、来源删除、重建及大型项目耗时；对照人工标注的召回与噪声」。
 *
 * 🔴 为什么必须用合成数据：真实作品涉及作者的正文，不能拿来做对照实验的输入；
 *    而合成语料可以**精确知道正确答案**（哪一块应该被召回），召回率与噪声才有分母。
 * 🔴 全部确定性：固定种子 + 固定生成顺序 ⇒ 同一份代码每次跑出同样数字，
 *    否则「这次比上次好」不可复现，等于没有证据。
 */
import type { VecRow, VecKind } from '@/lib/semantic/store'

/** 确定性 PRNG（mulberry32）—— 不用 Math.random，否则报告不可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BenchQuery {
  id: string
  /** 查询文本（模拟「当前写到哪一段」） */
  text: string
  /** 人工标注：应该被召回的来源 refId */
  expectRefIds: string[]
  /** 这条查询的来历（报告里人看得懂） */
  note: string
  /** 期望召回为空（「确实没有相关资料」也是要有正确答案的） */
  expectEmpty?: boolean
  /** 用途过滤（模拟 `kinds`） */
  kinds?: VecKind[]
  /** 章节白名单（模拟叙事锚点） */
  allowChapterIds?: Set<string> | null
  /** 排除来源（模拟「焦点章本身不再召回」） */
  excludeRefIds?: Set<string> | null
  /**
   * 允许这些 refId 作为「等价命中」（同名实体的另一种表述）。
   * 只影响评分时的命中判定，不影响真实返回。
   */
  acceptRefIds?: string[]
}

export interface SyntheticCorpus {
  projectId: string
  rows: VecRow[]
  /** 另一个项目的行（用来验证跨项目不得串味） */
  foreignRows: VecRow[]
  queries: BenchQuery[]
  stats: { refs: number; chunks: number; chars: number }
}

const FILLER = [
  '他站在门外，雨水顺着屋檐落下，远处传来更鼓声。',
  '屋里的灯摇晃了一下，影子被拉得很长。',
  '她没有回头，只是把手里的东西攥得更紧了一些。',
  '风从窗口灌进来，带起一层薄薄的灰。',
  '街上的人渐渐散了，只剩下几个收摊的小贩。',
]

function row(
  projectId: string, kind: VecKind, refId: string, chunkIdx: number, title: string, text: string,
): VecRow {
  return {
    id: `${projectId}::${kind}::${refId}::${chunkIdx}`,
    projectId,
    refKey: `${projectId}::${refId}`,
    kind,
    refId,
    chunkIdx,
    text,
    title,
    hash: `h-${kind}-${refId}-${chunkIdx}`,
    vec: new ArrayBuffer(0),
    dim: 0,
    model: 'synthetic',
    secret: false,
    updatedAt: 1,
  }
}

/**
 * 生成一份合成语料。
 *
 * 覆盖规划点名的六类难点：
 *   ① 短词（两字专名，单字命中不算命中）
 *   ② 同名（两个不同实体共用一个名字，靠类别/项目区分）
 *   ③ 跨章节（同一人物出现在多章，标注要求召回多章）
 *   ④ 空结果（查询确实无对应材料）
 *   ⑤ 来源删除 / 重建（先删掉来源行，再重建，结果应恢复）
 *   ⑥ 大型项目（`bulk` 控制规模，用于耗时对比）
 */
export function buildSyntheticCorpus(opts: { seed?: number; bulk?: number } = {}): SyntheticCorpus {
  const seed = opts.seed ?? 20261117
  const bulk = Math.max(0, opts.bulk ?? 0)
  const rand = rng(seed)
  const pid = 'proj-syn'
  const rows: VecRow[] = []

  // ---- ① 章节：主角「林照」在第 1/3/7 章各有明确情节（跨章节召回） ----
  const chapterTexts: Record<string, string> = {
    'ch-1': '林照推开木门，雪地上留下一串脚印。他在门后发现了半枚断裂的玉牌，玉牌上刻着"玄"字。',
    'ch-3': '林照在城南的当铺认出了那半枚玉牌，掌柜说这东西十年前就有人拿来当过。',
    'ch-7': '林照把玉牌按在石台上，玄字亮起，露出底下一条暗河。',
  }
  for (const [refId, text] of Object.entries(chapterTexts)) {
    rows.push(row(pid, 'chapter', refId, 0, `第${refId.slice(3)}章`, text))
  }

  // ---- ② 同名：两个「玄天宗」，一个在设定表（势力），一个在知识库（外来资料） ----
  rows.push(row(pid, 'setting', 'nations:玄天宗', 0, '玄天宗',
    '玄天宗：北境第一大宗，掌门为玄真子，与朝廷关系紧张。'))
  rows.push(row(pid, 'kb', 'kb-玄天宗note', 0, '玄天宗（资料笔记）',
    '资料笔记：玄天宗在另一部作品里是邪派，与本作设定无关，仅供写法参考。'))

  // ---- ③ 短词：「玉牌」两字专名，分散在多章；「牌」单字不应构成命中 ----
  //     （上面三章已含「玉牌」，这里再加一条只有「牌」的内容作干扰）
  rows.push(row(pid, 'chapter', 'ch-9', 0, '第9章', '桌上摆着一排木牌，每一块写着不同的名字。'))

  // ---- ④ 空结果：语料里完全没有「蒸汽机」相关内容 ----
  //     （不生成对应行，查询侧断言返回空）

  // ---- ⑤ 设定条目：供「用途过滤」用 ----
  rows.push(row(pid, 'setting', 'char:林照', 0, '林照',
    '林照：主角，出身寒门，右手有旧伤，性格克制。'))
  rows.push(row(pid, 'setting', 'terms:玄字', 0, '玄字',
    '玄字：玉牌上的刻纹，触发机关的关键。'))

  // ---- 摘要块：验证 kind 过滤（摘要与章节同源不同 kind） ----
  rows.push(row(pid, 'summary', 'ch-1', 0, '第1章（摘要）',
    '林照在雪夜发现半枚刻着玄字的玉牌。'))

  // ---- ⑥ 大型项目填充：确定性噪声块，用来量耗时与噪声率 ----
  const fillerRows: VecRow[] = []
  for (let i = 0; i < bulk; i++) {
    const a = FILLER[Math.floor(rand() * FILLER.length)]
    const b = FILLER[Math.floor(rand() * FILLER.length)]
    fillerRows.push(row(pid, 'chapter', `bulk-${i}`, 0, `填充第${i}章`, `${a}${b}`))
  }
  rows.push(...fillerRows)

  // ---- 另一个项目：同名实体，验证不得串味 ----
  const otherPid = 'proj-other'
  const foreignRows: VecRow[] = [
    row(otherPid, 'chapter', 'ch-x', 0, '第1章（别项目）', '林照在另一个故事里是反派，玉牌是他的信物。'),
    row(otherPid, 'setting', 'char:林照', 0, '林照（别项目）', '林照：另一部作品的反派主角。'),
  ]

  const queries: BenchQuery[] = [
    {
      id: 'q-short-word',
      text: '林照把那半枚玉牌收进怀里，想起雪夜的事。',
      expectRefIds: ['ch-1', 'ch-3'],
      note: '短词 + 跨章节：两字专名「玉牌」的出处应被召回',
    },
    {
      id: 'q-cross-chapter',
      text: '玉牌上的玄字到底通向哪里？林照盯着石台。',
      expectRefIds: ['ch-7'],
      note: '跨章节：剧情推进到第 7 章，应召回该章',
    },
    {
      id: 'q-same-name-filter',
      text: '玄天宗和朝廷的关系怎么样？',
      expectRefIds: ['nations:玄天宗'],
      kinds: ['setting'],
      note: '同名实体：按用途（只看设定）过滤，不得召回知识库里的同名笔记',
    },
    {
      id: 'q-same-name-kb',
      text: '玄天宗和朝廷的关系怎么样？',
      expectRefIds: ['kb-玄天宗note'],
      kinds: ['kb'],
      note: '同名实体：只看知识库时，应召回资料笔记而非设定',
    },
    {
      id: 'q-single-word',
      text: '玉牌',
      expectRefIds: ['ch-1', 'ch-3', 'ch-7'],
      note: '短词：只查一个专名（旧口径要求 2 个二元命中，物理上过不去 ⇒ 恒为空）',
    },
    {
      id: 'q-empty',
      text: '蒸汽机的活塞结构与锅炉压力',
      expectRefIds: [],
      expectEmpty: true,
      note: '空结果：语料里没有这方面材料，必须返回空而不是硬凑',
    },
    {
      id: 'q-single-char-noise',
      text: '桌上那些木牌',
      expectRefIds: ['ch-9'],
      acceptRefIds: ['ch-9'],
      note: '单字干扰：只有「牌」字命中的其它块不应挤掉真正讲木牌的那一章',
    },
    {
      id: 'q-anchor-filter',
      text: '林照又想起了那半枚玉牌。',
      expectRefIds: ['ch-3'],
      allowChapterIds: new Set(['ch-3']),
      note: '叙事锚点：限定只在这一章范围里召回',
    },
    {
      id: 'q-exclude-focus',
      text: '林照又想起了那半枚玉牌。',
      expectRefIds: ['ch-3'],
      excludeRefIds: new Set(['ch-1']),
      note: '排除焦点章：本章正文已在提示里，不该再占召回名额',
    },
  ]

  const chars = rows.reduce((n, r) => n + r.text.length, 0)
  return {
    projectId: pid,
    rows,
    foreignRows,
    queries,
    stats: { refs: new Set(rows.map(r => `${r.kind}::${r.refId}`)).size, chunks: rows.length, chars },
  }
}
