/**
 * 酒馆模式 · 模型解析（第 5 批抽出来的）。
 *
 * 【为什么要单独成文件】**禁环**是项目纪律。背景设定（world.ts）也要解析模型，
 * 而 engine 要用 world（注入那一层）—— 若 world 从 engine 引就成了 engine → world → engine。
 * 把这段纯逻辑上移一个文件，两边都引它，环自然断掉（与「常量上移 types.ts」同一条思路）。
 *
 * engine 仍 re-export 它，既有调用点（summarize / revise / 各组件）不必改。
 */
import { chat, loadProviders, requireActiveProvider, type AIProvider } from '../ai'

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
  // 优先会话自己指定的；会话没指定则用**控制面板的默认模型**；都没有才回退全局活动模型
  const want = ref?.providerId || fallbackProviderId || ''
  if (want) {
    const list = await loadProviders()
    const hit = list.find(p => p.id === want)
    if (hit) return { provider: hit, fellBack: false }
  }
  return { provider: await requireActiveProvider(), fellBack: true }
}
