/** 当前编辑器正在打开的章节 id —— 供 Agent 写操作判断「该章是否正被编辑」。 */
let activeChapterId: string | null = null

export function setAgentActiveChapter(id: string | null): void {
  activeChapterId = id
}

export function getAgentActiveChapter(): string | null {
  return activeChapterId
}