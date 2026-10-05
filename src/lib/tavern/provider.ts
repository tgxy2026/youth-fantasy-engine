/**
 * 酒馆模式 · 模型解析（第 5 批抽出来的）。
 *
 * 【为什么要单独成文件】**禁环**是项目纪律。背景设定（world.ts）也要解析模型，
 * 而 engine 要用 world（注入那一层）—— 若 world 从 engine 引就成了 engine → world → engine。
 * 把这段纯逻辑上移一个文件，两边都引它，环自然断掉（与「常量上移 types.ts」同一条思路）。
 *
 * engine 仍 re-export 它，既有调用点（summarize / revise / 各组件）不必改。
 */
import { chat, isProviderUsable, typeLabel, loadProviders, requireActiveProvider, type AIProvider } from '../ai'
import { getTavernSettings } from './settings'

/** 「调一次模型」的函数类型 —— 测试注入桩模型用的口子 */
export type ChatFn = typeof chat

/**
 * 解析本轮要用的模型。
 * 酒馆模式**单独指定模型**（方案 §7.8），只存 providerId 引用，不复制模型配置；
 * 没配或配的那个已被删除时，回退到全局活动模型（并在 UI 上提示）。
 */
export async function resolveTavernProvider(
  ref?: { providerId?: string },
  fallbackProviderId?: string,
): Promise<{ provider: AIProvider; fellBack: boolean }> {
  // 优先会话自己指定的；会话没指定则用**控制面板的默认模型**；都没有才回退全局活动模型。
  //
  // 🔴 面板默认模型在这里兜底，而不是指望每个调用点自己传第二参 ——
  //    旧实现只有「对话轮次」那两处传了它，总结 / 审校 / 起草 / 报告 / 导入 / 访谈
  //    全都漏传，于是「留空 = 跟随默认模型」这句承诺在那些功能上根本不成立：
  //    它们直接跳到了全局活动模型，跟作者在控制面板上选的模型毫无关系。
  let fallback = fallbackProviderId
  if (!fallback) {
    try {
      fallback = (await getTavernSettings()).common.defaultProviderId
    } catch {
      // 设置读不出来（存储异常）时按「没配默认模型」处理，继续走全局活动模型
    }
  }
  const want = ref?.providerId || fallback || ''
  if (want) {
    const list = await loadProviders()
    const hit = list.find(p => p.id === want)
    if (hit) return { provider: hit, fellBack: false }
  }
  return { provider: await requireActiveProvider(), fellBack: true }
}

/** 就绪判定的结果（与 `useAIReady` 的 `AIReadyInfo` 同形，但判据是**酒馆这一条链**） */
export type TavernReadyInfo = {
  /** 是否存在「配置完整、本轮真能用」的模型 */
  ready: boolean
  /** 当前模型的简短标识，如「本地 Ollama · qwen3:8b」；未就绪为空串 */
  label: string
  /** 是否回退到了「全局活动模型」（会话与面板都没指定，或指定的那个已被删除） */
  fellBack: boolean
  /**
   * 当前生效模型的上下文窗口（tokens）。**没填就是 undefined**（老库里的模型配置可能没这个字段）。
   * 界面据此算世界书注入额度（`quotas.quotaProfileOf`）—— 与引擎侧同源，不重复实现解析链。
   */
  windowTokens?: number
}

/**
 * 酒馆侧的「模型就绪」判定 —— **判据必须与真实调用链一致**，否则守卫会误禁。
 *
 * 🔴 为什么不直接用全局的 `useAIReady`（2026-09-22 六维审计 F1 踩坑）：
 *    `useAIReady` 只看**全局活动模型**（`getActiveProvider`）。而酒馆的模型来源是
 *    「会话 model → 面板 `defaultProviderId` → 全局活动模型」这条三层兜底链
 *    （见上面的 `resolveTavernProvider`）。作者完全可能把全局活动模型留空、
 *    只在酒馆控制面板里指定一个模型 —— 那时全局判据说「未就绪」，
 *    用它去禁用发送键，就把一个**本来能正常跑**的场景禁掉了（比不加守卫更糟）。
 *
 * 所以这里复用同一条解析链，只把「拿不到就抛」换成「返回 false」。
 * 未配置时**不要**抛 —— 调用方是渲染期的守卫，抛会炸掉整个组件。
 */
export async function checkTavernReady(ref?: { providerId?: string }): Promise<TavernReadyInfo> {
  try {
    const { provider, fellBack } = await resolveTavernProvider(ref)
    return {
      ready: isProviderUsable(provider),
      label: providerLabel(provider),
      fellBack,
      windowTokens: provider.contextWindow,
    }
  } catch {
    // requireActiveProvider 在「全局活动模型也没配」时抛 —— 这正是「未就绪」本身
    return { ready: false, label: '', fellBack: true }
  }
}

/** 模型简短标识（与 `ai.ts` 内部 `aiReadySnapshot` 的口径一致：`名称或类型 · 模型名`） */
function providerLabel(p: AIProvider): string {
  return `${p.name || typeLabel(p)} · ${p.model}`
}