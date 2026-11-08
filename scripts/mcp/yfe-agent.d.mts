// scripts/mcp/yfe-agent.mjs 的类型声明（测试用）。
export const BRIDGE_VERSION: string
export const HOST_FILE_NAME: string
export const BRIDGE_TOOL_NAMES: string[]
export const BRIDGE_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; action?: string }[]
export function loadHost(file: string): { port: number; token: string; enabled: boolean; scope: { projects: { projectId: string; actions: string[] }[] } }
export function invoke(name: string, args: Record<string, unknown>, hostFile?: string): Promise<unknown>