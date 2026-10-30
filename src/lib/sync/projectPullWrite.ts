// ============ 3.3.2 · B3-2 另存为新书的写库层 ============
//
// 【为什么单独一层】`projectPullBundle` 负责"下下来、装成项目包"（可用假 deps 穷举测），
//   本模块只做最后一步真实世界动作：调用 `importProject()` 落库，并把失败翻译成人话。
//
// 🔴 写入目标是 `importProject()` 生成的**全新项目 id**：
//   原项目的任何记录都不被读取-改写-写回，所以本流程不需要"备份原项目"这一步，
//   也不会出现「写到一半把原书弄坏」——这是它比「用云端覆盖本机」优先开放的原因。
//
// 🔴 `localDirty:false` 的解释在 `projectPullBundle`：本流程不改本机任何现有内容。
import { importProject } from '@/lib/db/projects'
import { loadCloudCopy, type LoadCloudCopyInput } from '@/lib/sync/projectPullBundle'

export interface SaveCloudCopyResult {
  ok: boolean
  /** 新项目 id（ok 时必有） */
  projectId?: string
  /** 新项目名（界面可直接显示） */
  name?: string
  /** 失败原因 / 成功时为空串 */
  reason: string
  /** 副本没带过来的内容（界面如实提示） */
  omitted: string[]
  /** 写进新项目的记录条数 */
  records: number
}

/**
 * 把云端某个版本另存为一本新的本地作品。
 * @param input 与 `loadCloudCopy` 相同（云端 id、原项目元数据、名称、指定版本、测试注入）
 */
export async function saveCloudCopyAsNewProject(input: LoadCloudCopyInput): Promise<SaveCloudCopyResult> {
  const loaded = await loadCloudCopy(input)
  if (!loaded.ok || !loaded.bundle) {
    return { ok: false, reason: loaded.reason, omitted: loaded.omitted, records: 0 }
  }

  try {
    const projectId = await importProject(loaded.bundle)
    return {
      ok: true,
      projectId,
      name: loaded.name,
      reason: '',
      omitted: loaded.omitted,
      records: loaded.records,
    }
  } catch (e) {
    return {
      ok: false,
      reason: `另存失败：${e instanceof Error ? e.message : '本机写入出错'}（原有作品未受影响）`,
      omitted: loaded.omitted,
      records: 0,
    }
  }
}