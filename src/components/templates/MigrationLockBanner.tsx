/**
 * 「正在更换模板」横幅（3.2.1 · 闭合 3.2.0 方案 §3.6 的可见性缺口）
 *
 * 【它补的是什么】
 *   `migrationGuard` 的**写入拦截**早已完整（`guardTabWrite` 被草稿恢复 / 自动保存 /
 *   AI 回填 / 导入四条路径调用），但被拦下的人**看不到原因** ——
 *   作者只知道"保存没反应"，会反复重试、甚至以为是自己写坏了。
 *   `isAnyTabMigrationActive` / `subscribeMigrationLock` 当初就是为这条横幅写的，
 *   只是入口一直没接（2026-10-22 六维审计的 A 类死代码里挂着）。
 *
 * 【为什么只做"告知"，不给操作按钮】
 *   迁移由模板管理弹窗发起、也由它收尾。这里放"取消迁移"等于在另一个入口
 *   操作同一件长任务，会和弹窗里的状态机抢时序 —— 只告知、不做事，是这层该有的边界。
 *
 * 【为什么说"改动不会丢"】
 *   四条路径被拦时都返回冲突对象、**不吞掉**内容（草稿仍在编辑器里，
 *   自动保存只是这次没落库）。所以这句话是事实，不是安慰。
 */
import { useEffect, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { getTab } from '@/lib/schema'
import { activeMigrationTabIds, subscribeMigrationLock } from '@/lib/templates/migrationGuard'
import { Z } from '@/lib/app/zLayer'

export function MigrationLockBanner({ projectId }: { projectId: string }) {
  const [tabIds, setTabIds] = useState<string[]>(() => activeMigrationTabIds(projectId))

  useEffect(() => {
    // 订阅的是"锁变了"这个事件，不带载荷 —— 回调里重新读一次即可
    return subscribeMigrationLock(() => setTabIds(activeMigrationTabIds(projectId)))
  }, [projectId])

  if (tabIds.length === 0) return null

  const names = tabIds.map(id => getTab(id)?.name ?? id)
  const subject = names.length === 1 ? `「${names[0]}」` : `${names.length} 个页签（${names.join('、')}）`

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 flex items-start gap-3 border-b-2 border-amber/70 bg-amber/15 px-4 py-2.5 text-ink-100 shadow-lg backdrop-blur-xs"
      style={{ zIndex: Z.banner }}
    >
      <ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
      <div className="min-w-0 flex-1 text-12 leading-snug">
        <div className="font-semibold text-amber">
          {subject}正在更换模板，该页签的写入已暂停
        </div>
        <div className="mt-0.5 text-ink-300">
          草稿恢复 / 自动保存 / AI 填写回写 / 导入都会先被拦下 —— 新旧字段结构不同，
          中途写入会把两套结构的值混进同一行。
        </div>
        <div className="mt-0.5 text-ink-500">
          你的改动还在编辑器里，没有丢；迁移结束后这条提示会自动消失，届时手动保存一次即可。
        </div>
      </div>
    </div>
  )
}
