export interface ProcessState {
  exitCode: number | null
  signal?: string | null
  timedOut?: boolean
  error?: string | null
  aborted?: boolean
  outputLimit?: boolean
}
export interface ProcessResult extends ProcessState {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  out: string
  pid: number | null
  durationMs: number
  cleanupComplete: boolean
}
export function processVerdict(state: ProcessState): { ok: boolean; code: number }
export function runProcess(command: string, args?: string[], options?: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; maxOutputChars?: number
}): Promise<ProcessResult>
