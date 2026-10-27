/** Interactive operations must retain their original mounted owner, including preparation time.
 * This does not cancel I/O already issued to a backend.
 */
export function beginRecordOperation(projectId: string, current: () => boolean) {
  const assertCurrent = () => {
    if (!projectId || !current()) throw new Error('资料上下文已改变，请回到原项目重新操作')
  }
  assertCurrent()
  return { projectId, current, assertCurrent }
}
