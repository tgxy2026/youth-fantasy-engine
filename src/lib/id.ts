/**
 * 生成全局唯一 id。
 *
 * 之前各模块各写一份 uid()，格式还不一致（组件用 5 位随机、db 用 6 位、
 * 种子数据甚至把随机串放前面）。统一在此导出，杜绝格式漂移；id 仅作
 * 内部不透明主键使用，调用方不应依赖其具体长度或构成。
 */
let uidSeq = 0
export function uid(): string {
  uidSeq = (uidSeq + 1) & 0xffffff
  return Date.now().toString(36) + uidSeq.toString(36).padStart(5, '0') + Math.random().toString(36).slice(2, 8)
}
