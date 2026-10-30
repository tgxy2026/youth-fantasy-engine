// ============ 3.3.2 · B3-2 另存为新书的写库层 ============
//
// 【为什么单独一层】`projectAsCopy` 是纯函数（证明"要写的形状对不对"），
//   本模块负责真实世界那三件纯函数做不了的事：联网下载、调用导入、把失败如实翻译成人话。
//
// 🔴 写入目标是 `importProject()` 生成的**全新项目 id**：
//   原项目的任何记录都不被读取-改写-写回，所以本流程不需要"备份原项目"这一步，
//   也不会出现「写到一半把原书弄坏」——这是它比「用云端覆盖本机」优先开放的原因。
//
// 🔴 `localDirty` 传 false 是**语义**不是绕过保护：
//   "本机有未同步改动"拦的是"覆盖本机稿子"（planApply 的 LOCAL_DIRTY）。
//   本流程不改本机任何现有内容，原项目的未同步改动仍然安全留在本机。
//
// 🔴 缺图不拦正文，但必须如实说：`projectPull` 会把没下到的图片字段删掉，
//   若不说，用户只会看到"副本里立绘没了"，以为同步把图吞了。
import type { Project } from '@/lib/types'
import { importProject } from '@/lib/db/projects'
import { buildPullPlan, type PullDeps } from '@/lib/sync/projectPull'
import { planAsCopy } from '@/lib/sync/projectAsCopy'
import { downloadObject, fetchManifest } from '@/lib/cloud/syncApi'

/** 生产环境的下载通道（Cookie 同源；桌面原生窗口另行处理，不走这里） */
export const defaultPullDeps: PullDeps = {
  fetchManifest: (cloudProjectId, rev) => fetchManifest(cloudProjectId, rev),
  downloadObject: (cloudProjectId, hash) => downloadObject(cloudProjectId, hash),
}

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
 *
 * @param input.baseProject 本机原项目（用于继承简介 / 封面 / 自定义功能）；纯云端下载时可不传
 * @param input.name 副本名；不传则「原名（云端副本）」
 * @param input.rev 指定云端版本；不传取最新
 * @param input.deps 仅供测试注入
 */
export async function saveCloudCopyAsNewProject(input: {
  cloudProjectId: string
  baseProject?: Project | null
  name?: string
  rev?: number
  deps?: PullDeps
}): Promise<SaveCloudCopyResult> {
  const deps = input.deps ?? defaultPullDeps

  // ① 下载 + 算计划（`localDirty:false` 的理由见文件头）
  const pull = await buildPullPlan(deps, {
    cloudProjectId: input.cloudProjectId,
    localDirty: false,
    rev: input.rev,
  })
  if (!pull.plan.ok || !pull.manifest) {
    const tail = pull.failed.length ? `（${pull.failed.length} 份内容没下到，可稍后重试）` : ''
    return { ok: false, reason: `${pull.plan.reason}${tail}`, omitted: [], records: 0 }
  }

  // ② 还原成项目包形状（id 重映射交给 importProject）
  const copy = planAsCopy({
    manifest: pull.manifest,
    loaded: pull.loaded,
    baseProject: input.baseProject ?? null,
    name: input.name,
  })
  if (!copy.ok || !copy.bundle) {
    return { ok: false, reason: copy.reason, omitted: copy.omitted, records: 0 }
  }

  const omitted = [...copy.omitted]
  if (pull.missingAssets > 0) omitted.push(`${pull.missingAssets} 张图片没下到（对应图片已省略，正文不受影响）`)

  // ③ 落库：全新项目 id，原项目零改动
  try {
    const projectId = await importProject(copy.bundle)
    return {
      ok: true,
      projectId,
      name: copy.bundle.project.name,
      reason: '',
      omitted,
      records: copy.stats.put,
    }
  } catch (e) {
    return {
      ok: false,
      reason: `另存失败：${e instanceof Error ? e.message : '本机写入出错'}（原有作品未受影响）`,
      omitted,
      records: 0,
    }
  }
}