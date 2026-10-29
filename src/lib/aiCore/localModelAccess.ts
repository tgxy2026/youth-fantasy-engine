// ============ P9 · 网页版对本机模型的统一禁用（3.3.1，主人 2026-10-30 定案：B 分支） ============
//
// 结论：**网页版（云端账号与游客两种模式）一律不使用本机 / 局域网模型端点**。
// 依据（见进度文档 P9 段）：浏览器对 `http://127.0.0.1` / 局域网的访问受安全策略、混合内容与
// 端口拦截影响，实测只是「条件性可达」，无法在发布手册里承诺；与其让作者配好一个大概率连不上的
// 模型、再对着「请求失败」猜原因，不如明确说「网页版不支持，请用联网模型」。
//
// 🔴 三条硬要求（规划 §P9：覆盖旧配置、用途路由、模型列表、生成与嵌入，不能只隐藏按钮）：
//   ① 判据是**配置**层面的：已有配置不会被删掉，但解析「当前模型」时一律跳过它（旧配置自动失效）；
//   ② 所有取模型的入口共用这一个判据 —— `aiCore/session` 与 `ai/aiRouting` 都走 `isLocalModelBlocked`，
//      这样生成、嵌入、拆书、答疑等调用点不需要各自判断；
//   ③ 界面必须说明原因并禁止「设为当前 / 测试」，而不是给一个点了没反应的按钮。
//
// ⚠️ 桌面版与便携版**不受影响**：`WEB` 为假时一切照旧（改这里的判据时先看 `platform.ts` 的注入来源）。
// ⚠️ 放在 `aiCore/` 而不是 `ai/`：`ai/*` 里的 aiRouting 依赖 `aiCore/session`，本模块又被 session 用到 ——
//    放同一层才不会绕成目录级环（闸 importCycles 会查这个）。
import { WEB } from '@/lib/app/platform'
import { isLocalModelProvider } from '@/lib/aiCore/localModelPolicy'
import type { AIProvider } from '@/lib/aiCore/core'

/** 网页版是否禁用本机模型（当前定案：禁用） */
export const WEB_BLOCKS_LOCAL_MODEL = true

/** 给作者看的统一说明（模型列表、添加入口、报错文案共用一句，避免三处各写一版） */
export const WEB_LOCAL_MODEL_NOTICE =
  '网页版不支持连接本机 / 局域网模型（Ollama、LM Studio、LocalAI 等）：浏览器无法稳定访问本机服务。'
  + '请改用「添加联网模型」（硅基流动 / DeepSeek / 通义 等），或使用桌面版 / 便携版。'

/** 列表行上的短徽标 */
export const WEB_LOCAL_MODEL_BADGE = '网页版不支持'

/**
 * 纯判据：在这个运行形态下，这条配置是否被禁用。
 *
 * 单独抽出来是为了可单测 —— 平台标志是模块求值时注入的常量，测试里没法真的切换它。
 */
export function blocksLocalModel(web: boolean, provider: Pick<AIProvider, 'type' | 'local' | 'baseUrl'>): boolean {
  if (!web || !WEB_BLOCKS_LOCAL_MODEL) return false
  return isLocalModelProvider(provider)
}

/** 界面用：当前运行形态下是否整体禁用「添加本机模型」入口 */
export const LOCAL_MODEL_DISABLED = WEB && WEB_BLOCKS_LOCAL_MODEL

/** 运行时判据（网页版 + 本机地址） */
export function isLocalModelBlocked(provider: Pick<AIProvider, 'type' | 'local' | 'baseUrl'>): boolean {
  return blocksLocalModel(WEB, provider)
}

/** 过滤出当前形态下**真的能用**的模型配置（顺序不变） */
export function usableProviders<T extends Pick<AIProvider, 'type' | 'local' | 'baseUrl'>>(list: readonly T[]): T[] {
  return list.filter(provider => !isLocalModelBlocked(provider))
}

/** 被形态禁掉的配置（界面用来提示「这些为什么不能用」） */
export function blockedProviders<T extends Pick<AIProvider, 'type' | 'local' | 'baseUrl'>>(list: readonly T[]): T[] {
  return list.filter(provider => isLocalModelBlocked(provider))
}
