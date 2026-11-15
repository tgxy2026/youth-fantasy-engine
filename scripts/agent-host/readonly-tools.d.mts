/** 桌面只读桥的测试用类型声明（只声明测试与外部脚本实际使用的导出）。 */
export const CHAPTER_RANGE_MAX_LIMIT: number
export function chapterVersionOf(content: string): string
export function parseChapterRangeArgs(args: Record<string, unknown> | undefined): {
  explicit: boolean
  offset: number
  limit: number
  expectedVersion: string | null
}
export function parseArgs(argv: string[]): { dataFile: string | null; portableRoot: string | null }
export function desktopUserDataDir(): string
export function resolveDataFile(args: { dataFile?: string | null; portableRoot?: string | null }): string
export function createReadonlyTools(dataFile: string, authorizedProjects?: string[] | null): {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  invoke(name: string, args?: Record<string, unknown>): Record<string, unknown>
}
export function serveReadonlyBridge(options: {
  tools: unknown
  invoke: (name: string, args?: Record<string, unknown>) => unknown
}): void
