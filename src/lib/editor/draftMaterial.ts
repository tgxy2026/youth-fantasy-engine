/**
 * 起草 / 补全的**素材管线**（项目级）
 *
 * 所有「一句话 → 按模板填」的入口共用这一套 plumbing，各自只提供自己的模板与提示词：
 *   ① 检索：按设置的检索方式决定「自己查 / 让模型查 / 不查」，并把结果整理成素材块；
 *   ② 素材：作者的一句话想法、粘贴的参考、现有内容（补完模式）都用 `authorBlock` 包起来；
 *   ③ 反馈：**这次到底用的是哪种模式**要一路带回界面（老大明确要求「给用户反馈使用的是哪种模式」）。
 *
 * 【为什么把「来源」做成返回值而不是让界面自己判】
 * 界面判的话就得复刻一遍「有没有 key / 查没查成 / 是不是 model 档」的逻辑 —— 两份判定必然漂移，
 * 表现是「弹窗说联网了，其实没查成」这种最难查的不一致。所以由本模块统一裁决，界面只负责显示。
 *
 * 【为什么住在项目级而不是酒馆里】
 * 2026-09-15 起，角色管理 / 表单 / 表格的「AI 补全」也要能联网取素材（老大点名的场景：
 * 「以 GTA5 的富兰克林为模板，在《吞天神脉》里新增一个主要角色」）。它本来就没有任何酒馆依赖
 * （只用 `webSearch`），放在 `lib/tavern/` 里会让别的模块被迫 import 酒馆引擎。
 */
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import {
  webSearch, renderSearchResults, SEARCH_ENGINE_LABEL,
  type SearchOutcome, type SearchSettings,
} from '@/lib/ai/webSearch'

/** 这次起草的**素材来源**（界面据此告诉作者「本次用的是哪种模式」） */
export type DraftSource = {
  mode: SearchSettings['mode']
  /** 显示用：模型已有知识 + 粘贴素材 / 模型自带联网 / 搜索接口（<引擎名>） */
  label: string
  /** 我们这边**确实取回了**外部资料（只有「搜索接口」档成功时才为 true） */
  used: boolean
  /** 这次到底有没有真的联上网（详见 WebVerdict 的注释） */
  web: WebVerdict
  /** 没查成的原因（used=false 时给界面看，绝不静默） */
  error?: string
  /** 附加说明（例如「是否真的联网取决于所选模型」这种无法验证的实情） */
  note?: string
}

/**
 * 「这次联网了吗」——由**产出素材的那一侧**裁决，界面与提示词都不许自己猜。
 * 猜错的后果比不报还坏：作者以为资料是查来的，就会拿它当事实。
 *
 *   · `searched`  —— 我们确实取回了外部资料（只有「搜索接口」档**成功**时成立）
 *   · `failed`    —— 我们查了，但没成（原因在 `error` 里）
 *   · `delegated` —— 交给模型/中转自己查，**本软件无法验证**（选了「模型自带联网」）
 *   · `off`       —— 按设置就没联网
 */
export type WebVerdict = 'searched' | 'failed' | 'delegated' | 'off'

/**
 * 把 source 翻译成「作者一眼能看懂的结论」（纯函数 —— 界面只负责渲染，判定只有这一处）。
 *
 * 🔴 三档都要给结论，不能只在成功时说一句：
 *   作者选「联网」是想要真实资料；**没联上却不说**，他就会把模型编的东西当成查来的事实
 *   （老大 2026-09-15 点名要求：生成内容的同时必须说明这次到底联没联）。
 */
export function describeSource(s: DraftSource): { tone: 'ok' | 'warn' | 'muted'; headline: string; detail: string } {
  switch (s.web) {
    case 'searched':
      return {
        tone: 'ok',
        headline: `已联网：${s.label} 取回了外部资料`,
        detail: s.note ?? '',
      }
    case 'failed':
      return {
        tone: 'warn',
        headline: '本次没有联网 —— 检索没成功',
        detail: `下面这些是模型凭已有知识生成的，不是检索到的资料。${s.error ? '原因：' + s.error : ''}`,
      }
    case 'delegated':
      return {
        tone: 'warn',
        headline: '本次无法确认是否联网',
        detail: '已要求模型自行检索，但本软件看不到这一步。若你选的模型/中转不支持联网，'
          + '下面这些就是它凭已有知识生成的 —— 把它当参考，别当查证过的事实。',
      }
    default:
      return {
        tone: 'muted',
        headline: '本次未联网（按你的设置）',
        detail: '内容基于模型已有知识与你自己提供的素材。',
      }
  }
}

export type DraftMaterial = {
  /** 拼好的素材块（空串 = 没有额外素材） */
  blocks: string
  source: DraftSource
}

export type DraftMaterialArgs = {
  /** 作者的一句话想法 */
  idea: string
  /** 作者粘贴的参考素材（可空） */
  refs?: string
  /** 补完模式：现有内容的摊平文本（可空） */
  existing?: string
  settings: SearchSettings
  signal?: AbortSignal
  /** 测试用：替换检索实现 */
  searchFn?: typeof webSearch
}

const MODE_LABEL: Record<SearchSettings['mode'], string> = {
  off: '模型已有知识 + 粘贴素材',
  model: '模型自带联网',
  api: '搜索接口',
}

/**
 * 准备素材块，并裁决「这次用的是哪种来源」。
 *
 * 三种方式的行为差异：
 *   · `off`   —— 不查。素材 = 作者的想法 + 粘贴的参考（+ 现有内容）。
 *   · `model` —— 让**模型自己**查：在素材块里写一条明确的检索指令。⚠️ 我们无法验证它是否真的查了，
 *                所以 note 里如实写明「是否真的联网取决于所选模型/中转」——不吹这个牛。
 *   · `api`   —— 我们查：有密钥/地址就跑，结果连同网址一起喂给它；查失败**照样继续**（用模型知识），
 *                但把 error 带回去让界面如实告诉作者。
 */
export async function prepareDraftMaterial(a: DraftMaterialArgs): Promise<DraftMaterial> {
  const fence = newAuthorFence()
  const parts: string[] = []
  let source: DraftSource = { mode: a.settings.mode, label: MODE_LABEL[a.settings.mode], used: false, web: 'off' }

  if (a.settings.mode === 'off') {
    source = { ...source, note: '未联网：只依据模型已有知识与下面粘贴的素材' }
  } else if (a.settings.mode === 'model') {
    source = {
      ...source,
      // 🔴 used 的含义是「我们这边确实取回了外部资料」——交给模型自己查不属于这种情况。
      //    这里原先写的是 true，界面于是会理直气壮地说「已用上外部资料」；
      //    可模型到底联没联网我们根本看不到，那句话在最坏的情况下就是纯撒谎。
      used: false,
      web: 'delegated',
      note: '已要求模型自行检索，但本软件看不到这一步 —— 是否真的联到网取决于你选的模型/中转',
    }
  } else {
    const run = a.searchFn ?? webSearch
    const query = a.idea.trim() || a.refs?.trim().slice(0, 60) || ''
    const outcome: SearchOutcome = query
      ? await run(query, a.settings, a.signal)
      : { used: false, engine: a.settings.engine, query: '', results: [], error: '没有可检索的内容（想法写太空了）' }
    source = {
      mode: 'api',
      // 🔴 引擎名必须取自 SEARCH_ENGINE_LABEL（唯一真源）。这里原先写成
      //    「custom 否则一律博查」，加进 SearXNG 之后界面就开始撒谎 —— 明明走的是
      //    SearXNG，回执却报「博查」。档位名宁可少写，也不能写错：作者是拿它判断能不能用的。
      label: `搜索接口（${SEARCH_ENGINE_LABEL[a.settings.engine]}）`,
      used: outcome.used,
      web: outcome.used ? 'searched' : 'failed',
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.used ? { note: `检索词：${outcome.query} · 命中 ${outcome.results.length} 条` } : {}),
    }
    const rendered = renderSearchResults(outcome)
    if (rendered) parts.push(rendered)
  }

  if (a.refs?.trim()) {
    parts.push(`〖作者粘贴的参考素材〗\n${authorBlock(fence, a.refs.trim())}`)
  }
  if (a.existing?.trim()) {
    parts.push([
      '〖现有内容（这是在已有基础上补完，不是从零开始）〗',
      authorBlock(fence, a.existing.trim()),
      '',
      '要求：「已经写好且没问题的部分照原样保留」；只补空缺、只改与素材明显冲突的地方。',
      '不要重写已经成立的设定 —— 作者认得出哪些字是他自己写的。',
    ].join('\n'))
  }

  return { blocks: parts.join('\n\n'), source }
}
