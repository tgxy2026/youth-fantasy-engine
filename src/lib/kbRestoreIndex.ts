/**
 * 还原 / 导入之后：把「带回来的、已启用」的参考资料**自动重建索引**（2026-10-04 · 台账 #017 收尾）。
 *
 * 为什么必须有它：
 *   `restoreDocsFromBundle` 恢复时**先把旧资料连同向量块一起清空**（这是对的 —— 正文都换了，
 *   旧块留着就是"指向已删资料的幽灵块"，会混进上下文），再按包里的启用态写回新文档。
 *   于是新文档 `enabled: true` 但 `chunkCount: 0`、向量库里一块都没有 ⇒
 *   **「界面显示已启用、检索却一条也捞不到」的静默降级**，作者完全看不出原因。
 *
 * 设计取舍（主人 2026-10-04 拍板：**自动重建**，而不是"提示作者自己去点"）：
 *   · 走 `aiTaskCenter` 的模块级纯函数 `startTask` ⇒ 任务跨页签存活、**可中止**、进度可见；
 *   · 🔴 复用素材页同一个 `(ownerTab='material-library', kind='kb-index')` ⇒ 与手动「重建索引」
 *     **天然互斥**（`startTask` 对同键 running 直接忽略），不会同时跑两遍白烧嵌入额度；
 *   · 🔴 **不静默**：未配嵌入模型时也起一条任务、如实说明「暂时只走关键词匹配 + 去哪配」，
 *     绝不假装成功（静默失败＝本项目 P0）。
 *
 * 🔴 本模块**只能由 `components` 调用**，绝不能挂进 `lib/db`：
 *   `semantic/settings` 会 import `db`，而 `db/projects`（importProject）与 `db/backups`
 *   （restoreBackup / restoreBundleToProject）正是**还原的发起方**做 import 就成环：
 *   `db → kbRestoreIndex → semantic/settings → db`。（`importCycles` 闸会炸。）
 */
import { startTask } from './aiTaskCenter'
import { listDocsStrict, reindexAll, type ReindexProgress } from './knowledgeBase'
import { embeddingStatus, resolveEmbedConfig } from './semantic/settings'

/** 任务结果形状（与素材页「重建索引」一致，供任务中心展示） */
export interface KbIndexTaskResult {
  ok: boolean
  docs: number
  chunks: number
  failed: number
  error?: string
}

/** 归属页签 / 类别 / 显示名 —— 与 `KnowledgeBasePanel` 的「重建索引」共用（互斥 + 指示器点回去看） */
const OWNER_TAB = 'material-library'
const KIND = 'kb-index'
const TITLE = '建立参考资料索引'

/**
 * 还原 / 导入完成后调用（缺省无「已启用」资料 ⇒ 静默返回、不产生任何任务）。
 *
 * 🔴 **非阻塞**：调用方按 `void rebuildKbIndexAfterRestore(pid)` 用即可，不必 await ——
 *    重建是长任务，绝不能卡住「恢复完成」这条路；失败也只影响索引，不影响已还原的数据。
 */
export async function rebuildKbIndexAfterRestore(projectId: string): Promise<void> {
  if (!projectId) return

  let enabled: number
  try {
    enabled = (await listDocsStrict(projectId)).filter(d => d.enabled).length
  } catch (e) {
    // 🔴 读失败**不能当成「没有资料」静默返回**（2026-10-04 六维审计）：
    //    那会把一次真实的库读取故障，伪装成「这次还原没有资料要建索引」，作者永远不知道索引没建上。
    //    起一条 info 任务如实说明 —— 不阻断已完成的还原（调用方本来就是 void 调用）。
    startTask<KbIndexTaskResult, ReindexProgress>({
      ownerTab: OWNER_TAB, kind: KIND, title: TITLE, writes: ['kb'],
      run: async () => ({
        ok: false, docs: 0, chunks: 0, failed: 0,
        error: '还原后读不到参考资料库，本次无法自动重建索引：'
          + (e instanceof Error ? e.message : String(e))
          + ' —— 带回来的参考资料可能尚未建立索引，稍后可在「素材资料」页点「重建索引」。',
      }),
      notify: info => (info.status === 'done' && !info.result?.ok)
        ? { text: info.result?.error ?? '参考资料库读取失败', kind: 'info' as const }
        : null,
    })
    return
  }
  if (!enabled) return

  const emb = await embeddingStatus()
  if (!emb.ready) {
    // 未配嵌入模型：不算错误（`resolveEmbedConfig` 的口径就是"未配置是常态"），但要**如实说** ——
    // 用 info 而不是 error，避免把一种"配置状态"渲染成"故障"。
    startTask<KbIndexTaskResult, ReindexProgress>({
      ownerTab: OWNER_TAB, kind: KIND, title: TITLE, writes: ['kb'],
      run: async () => ({
        ok: false, docs: 0, chunks: 0, failed: 0,
        error: `本项目有 ${enabled} 篇已启用的参考资料，但当前未配置嵌入模型（${emb.reason}）——`
          + '它们现在只能走关键词匹配，语义检索捞不到。配好后在「素材资料」页点「重建索引」即可。',
      }),
      notify: info => (info.status === 'done' && !info.result?.ok)
        ? { text: info.result?.error ?? '未配置嵌入模型', kind: 'info' as const }
        : null,
    })
    return
  }

  const cfg = await resolveEmbedConfig()
  if (!cfg) return // `embeddingStatus` 说就绪却解析不出（设置被并发改掉）⇒ 退回静默，状态行仍会如实显示

  startTask<KbIndexTaskResult, ReindexProgress>({
    ownerTab: OWNER_TAB, kind: KIND, title: TITLE, writes: ['kb'],
    run: ctx => reindexAll(projectId, cfg, ctx.signal, p => ctx.progress(p)),
    notify: info => {
      const r = info.result
      if (info.status === 'aborted') {
        return { text: '还原后重建参考资料索引已中止 —— 已建好的部分保持可用', kind: 'info' as const }
      }
      if (info.status === 'done' && r?.ok) {
        return {
          text: `还原后已自动重建参考资料索引：${r.docs} 篇 / ${r.chunks} 块${r.failed ? ` · ${r.failed} 篇失败` : ''}`,
          kind: 'success' as const,
        }
      }
      return { text: `还原后自动重建参考资料索引失败：${r?.error ?? info.error ?? '未知原因'}`, kind: 'error' as const }
    },
  })
}
