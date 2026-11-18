/**
 * 三条「暂停写入 / 迁移中」横幅的文案映射（3.6.1 · B7 抽出）。
 *
 * 【为什么抽文案】这三条横幅的共同点是：**它们本身不给操作，只负责说清三件事**
 *   —— 为什么锁、怎么解、现在能做什么。文案写错就是误导（例如把「原文件没被改动」
 *   说成「数据已损坏」，作者会以为稿子没了）。
 *   三处原先各写一份，端与端之间还各抄一遍；这里统一成纯函数，测试直接比对整句。
 *
 * 🔴 这里只搬**已经在跑的句子**，没有新增或改写任何用户可见文案。
 */

/** 解锁确认框：说清「空库继续会覆盖原文件」，并带上本端能给的动作（备份指引） */
export function writeLockUnlockPrompt(backupHint: string): { title: string; message: string; danger: boolean } {
  return {
    title: '确定要用当前内容继续吗？',
    message:
      '当前内存里是「空库或残缺数据」—— 原文件没能读出来。\n\n'
      + '继续之后，只要有数据变动就会写回数据文件，磁盘上那份原文件会被覆盖，且无法恢复。\n\n'
      + backupHint,
    danger: true,
  }
}

/**
 * 便携版 / 网页版的横幅文案切换。
 * 网页版没有「本地数据文件路径」可复制 ⇒ 主操作换成「导出全部数据」，口径整体换成云端。
 */
export function portableWriteLockCopy(web: boolean): {
  subject: string
  writeBackTo: string
  primaryLabel: string
  backupHint: string
} {
  if (web) {
    return {
      subject: '云端数据',
      writeBackTo: '云端',
      primaryLabel: '导出全部数据',
      backupHint: '建议先导出一份 JSON 备份（可导入桌面版），再决定是否继续。',
    }
  }
  return {
    subject: '便携数据文件',
    writeBackTo: '数据文件',
    primaryLabel: '复制数据文件路径',
    backupHint: '建议先把数据文件复制一份备份（可点「复制数据文件路径」定位），再决定是否继续。',
  }
}

/** 迁移横幅的主语：单页签点名，多页签给个数 + 全名 */
export function migrationLockSubject(names: readonly string[]): string {
  if (names.length === 1) return `「${names[0]}」`
  return `${names.length} 个页签（${names.join('、')}）`
}
