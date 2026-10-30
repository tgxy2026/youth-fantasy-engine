// ============ 3.3.2 · B3-3 把云端版本装成项目包（不写库）============
//
// 【为什么单独一个模块】两个入口都要它：
//   · 「另存为新书」  → 拿到 bundle 后交给 `importProject()` 落库（见 `projectPullWrite`）
//   · 「导出云端这一版」→ 拿到 bundle 后直接序列化成 JSON 下载（见 `CloudSyncPanel`）
//   两者共同的步骤是「下载 + 还原图片 + 校验完整性」，全是网络动作，不能塞进纯函数
//   （`projectAsCopy` 只负责形状）。分开之后，下载这一段就能用假 deps 穷举测。
//
// 🔴 本模块**不读本机数据库、不写库**：只碰网络与内存。
// 🔴 失败原因必须分清「没下到」与「格式不认识」：否则用户只看到一句"另存失败"，无从判断是网络还是升级问题。
// 🔴 `localDirty:false` 是语义不是绕过保护：两个入口都不改本机现有项目 ——
//    一个写全新项目 id，一个只导出文件。原项目的未同步改动仍安全留在本机。
import type { ProjectBundle } from '@/lib/db/projects'
import type { Project } from '@/lib/types'
import { buildPullPlan, type PullDeps } from '@/lib/sync/projectPull'
import { planAsCopy } from '@/lib/sync/projectAsCopy'
import { downloadObject, fetchManifest } from '@/lib/cloud/syncApi'

/** 生产环境的下载通道（Cookie 同源；桌面原生窗口另行处理，不走这里） */
export const defaultPullDeps: PullDeps = {
  fetchManifest: (cloudProjectId, rev) => fetchManifest(cloudProjectId, rev),
  downloadObject: (cloudProjectId, hash) => downloadObject(cloudProjectId, hash),
}

export interface LoadCloudCopyInput {
  cloudProjectId: string
  /** 本机原项目（用于继承简介 / 封面 / 自定义功能）；纯云端下载时可不传 */
  baseProject?: Project | null
  /** 副本名；不传则「原名（云端副本）」 */
  name?: string
  /** 指定云端版本；不传取最新 */
  rev?: number
  /** 仅供测试注入 */
  deps?: PullDeps
}

export interface LoadedCloudCopy {
  ok: boolean
  bundle: ProjectBundle | null
  /** 项目名（导入 / 导出文件名都用它） */
  name: string
  /** 失败原因 / 成功时为空串 */
  reason: string
  /** 没带过来的内容（界面如实提示） */
  omitted: string[]
  /** 记录条数 */
  records: number
  revision: number
  snapshotId: string
}

export async function loadCloudCopy(input: LoadCloudCopyInput): Promise<LoadedCloudCopy> {
  const deps = input.deps ?? defaultPullDeps

  // ① 下载 + 算完整性计划（`localDirty:false` 的理由见文件头）
  const pull = await buildPullPlan(deps, {
    cloudProjectId: input.cloudProjectId,
    localDirty: false,
    rev: input.rev,
  })
  if (!pull.plan.ok || !pull.manifest) {
    const tail = pull.failed.length ? `（${pull.failed.length} 份内容没下到，可稍后重试）` : ''
    return {
      ok: false, bundle: null, name: '', reason: `${pull.plan.reason}${tail}`,
      omitted: [], records: 0, revision: pull.plan.revision, snapshotId: pull.plan.snapshotId,
    }
  }

  // ② 还原成项目包形状（id 重映射留给 importProject）
  const copy = planAsCopy({
    manifest: pull.manifest,
    loaded: pull.loaded,
    baseProject: input.baseProject ?? null,
    name: input.name,
  })
  if (!copy.ok || !copy.bundle) {
    return {
      ok: false, bundle: null, name: '', reason: copy.reason,
      omitted: copy.omitted, records: 0, revision: copy.revision, snapshotId: copy.snapshotId,
    }
  }

  const omitted = [...copy.omitted]
  if (pull.missingAssets > 0) omitted.push(`${pull.missingAssets} 张图片没下到（对应图片已省略，正文不受影响）`)

  return {
    ok: true,
    bundle: copy.bundle,
    name: copy.bundle.project.name,
    reason: '',
    omitted,
    records: copy.stats.put,
    revision: copy.revision,
    snapshotId: copy.snapshotId,
  }
}

/** 导出文件名：去掉路径分隔符与 Windows 保留字符，避免下载时被浏览器改写或失败 */
export function cloudCopyFileName(name: string, revision: number): string {
  const safe = String(name || '云端副本').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return `${safe}-云端第${revision || 0}版.json`
}