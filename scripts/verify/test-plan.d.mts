export interface TestJob { id: string; batch: string; file: string; args: string[] }
export interface TestPlan { batchIds: string[]; actualEntries: number; jobs: TestJob[] }
export function readTestPlan(root: string, requested?: string[]): TestPlan
