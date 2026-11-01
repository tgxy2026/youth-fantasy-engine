/** A chapter exists but its recovery checkpoint could not be confirmed. */
export class CreativeCheckpointError extends Error {
  constructor() {
    super('章节已保存，但恢复进度未确认写盘；已停止续写，请先核对已保存章节。')
    this.name = 'CreativeCheckpointError'
  }
}
