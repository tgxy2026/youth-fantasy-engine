export function createSaveBarrier(): {
  readonly state: { paused: boolean; active: number; waiting: number }
  run<T>(save: () => T | Promise<T>): Promise<T>
  pause(): Promise<void>
  resume(): void
}
