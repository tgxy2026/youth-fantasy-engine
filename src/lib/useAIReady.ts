// AI 就绪状态 Hook
//
// 所有 AI 入口（补全 / 整理 / 校对 / 取名 / 深度自查）都用它来决定按钮是否可点。
// 订阅的是 ai.ts 里的全局状态，作者在「模型设置」里刚配好模型，
// 全应用的 AI 按钮会立刻同时亮起，不需要刷新页面。

import { useSyncExternalStore } from 'react'
import { aiReadySnapshot, subscribeAIReady, type AIReadyInfo } from './ai'

export function useAIReady(): AIReadyInfo {
  return useSyncExternalStore(subscribeAIReady, aiReadySnapshot, aiReadySnapshot)
}

export type { AIReadyInfo }
