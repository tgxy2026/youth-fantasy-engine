export interface TestExecutionReport {
  schemaVersion: number
  startedAt: string
  finishedAt: string
  actualEntries: number
  planned: number
  passed: number
  failed: number
  notRun: number
  batchIds: string[]
  results: { id: string; batch: string; status: string; ok?: boolean }[]
  ok: boolean
}
export function runTests(options?: { root?: string; batches?: string[]; reportPath?: string; signal?: AbortSignal }): Promise<TestExecutionReport>
