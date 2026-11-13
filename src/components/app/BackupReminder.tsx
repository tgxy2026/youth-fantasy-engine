import { useCallback, useEffect, useState } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '@/components/common/Button'
import * as db from '@/lib/db'
import { isDemoProjectName } from '@/lib/constants'
import { WEB } from '@/lib/app/platform'
import { isExportOverdue, isDismissExpired, markDismissed, shouldRemind, REMIND_AFTER_DAYS } from '@/lib/sync/backupReminder'

// #031 导出备份提醒：定期提醒用户把数据导出成外部文件，别让稿子只剩「同一个容器里」的那一份。
//
// 为什么需要它 —— 软件本身已有自动备份（每 5 分钟一份、每天一份，各留 30 份），
// 但自动备份写在**同一个存储里**（网页版 IndexedDB / 桌面与便携版的同一个 JSON 文件）。
// 也就是说：清站点数据、数据文件损坏、U 盘丢失、系统重装时，30 份自动备份会跟着一起消失。
// 自动备份只防「改坏了想回退」，防不了「整个容器没了」——这正是本提醒存在的理由。
//
// 触发条件（全部满足才出现）：
//   ① 距上次导出备份已超过 REMIND_AFTER_DAYS 天（从未导出过则首次即出现）
//   ② 「稍后再说」的短期静默期已过
//   ③ 确有真实数据可丢（已打开非示范项目，或项目列表里有非示范项目）——空库 / 只有示范项目不打扰
//
// 🔴 3.5.1 · U4（2026-11-11）：从**全屏 Modal** 改成**非阻断的内联提示条**。
//    原因：备份长期没做时，每次启动都弹一个盖住全屏的模态框，用户只能先关掉才能继续写 ——
//    把一个「可以稍后处理」的建议做成了路障。现在它挂在侧栏底部 / 项目中心列表上方：
//    想导就点按钮，不想导就照常干活，不会挡住任何操作。
//    🔴 项目中心**不放左下角数据坞**：内联条会把数据坞撑高约 120px，实测 1440×900 下
//       首个项目卡片的「打开项目」按钮正好被盖住（探针 elementFromPoint 命中数据坞把手）。
//       放进内容流既不会被盖，也不需要滚动才能看到。
//    说明性内容（自动备份为什么不顶用）收进「为什么？」展开区，不默认占屏。

/** 只数真实项目：示范项目不算「有数据可丢」 */
function realProjectCount(list: { name?: string }[]): number {
  return list.filter(p => !isDemoProjectName(p.name)).length
}

/**
 * 备份到期的判定与动作（抽出来只为让组件本身保持「看到 due 就画」）。
 *
 * 🔴 `isDemo` 时**不读库、不提醒**：示范项目是软件自带的演示数据，丢了随时能重建，
 *    拿它提醒用户「该备份了」既无意义也吓人（见 tests/backupReminder.test.ts ⑥）。
 */
export function useBackupDue({ hasProject, isDemo = false }: { hasProject: boolean; isDemo?: boolean }) {
  const [due, setDue] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (isDemo) {
        setDue(false)
        return
      }
      const exportOverdue = isExportOverdue()
      const dismissExpired = isDismissExpired()
      // ①② 不满足就不必去查项目列表（省一次库读）；判定本身在纯函数里（见 shouldRemind）
      if (!exportOverdue || !dismissExpired) {
        setDue(false)
        return
      }
      let projectCount = 0
      if (!hasProject) {
        const list = await db.getAllProjects().catch(() => [])
        if (!alive) return
        projectCount = realProjectCount(list)
      }
      if (alive) setDue(shouldRemind({ exportOverdue, dismissExpired, hasProject, projectCount, isDemo }))
    })()
    return () => {
      alive = false
    }
  }, [hasProject, isDemo])

  const dismiss = useCallback(() => {
    markDismissed()
    setDue(false)
  }, [])
  // 本会话内不再出现（不写存储）：导出成功后由 markExported 负责跨会话静默
  const hide = useCallback(() => setDue(false), [])

  return { due, dismiss, hide }
}

function BackupNotice({
  variant, hasProject, onExport, onDismiss,
}: {
  variant: 'sidebar' | 'hub'
  hasProject: boolean
  onExport?: () => void
  onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const hub = variant === 'hub'

  const whyToggle = (
    <Button
      variant="bare"
      size="xs"
      className={`px-1 text-ink-400 hover:text-amber ${hub ? '' : 'shrink-0'}`}
      onClick={() => setOpen(o => !o)}
      aria-expanded={open}
      title={open ? '收起说明' : '为什么自动备份不够？'}
    >
      {open ? '收起' : '为什么？'}
    </Button>
  )

  return (
    <div
      role="status"
      data-backup-notice={variant}
      className={`rounded-lg border border-amber/40 bg-amber/10 leading-relaxed ${
        hub ? 'mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-12' : 'p-2 text-11'
      }`}
    >
      {/* 🔴 hub 必须是**单行**（2026-11-11 实测）：多行横幅把卡片整体下推约 100px，
          1440×900 下首个卡片的「打开项目」正好落进固定数据坞（顶部 y≈606）里。
          单行约 46px，卡片底部回到数据坞上方；展开「为什么？」是用户主动动作，可以下推。 */}
      <div className={hub ? 'flex min-w-0 flex-1 items-center gap-1.5' : 'flex items-start gap-1.5'}>
        <FileUp size={13} className={`shrink-0 text-amber ${hub ? '' : 'mt-0.5'}`} />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-amber">该导出备份了</span>
          <span className={`text-ink-300 ${hub ? 'ml-1.5' : 'mt-0.5 block'}`}>
            距上次导出超过 {REMIND_AFTER_DAYS} 天。自动备份和数据存在同一处，容器没了会一起丢。
          </span>
        </div>
        {/* 侧栏很窄：说明入口放右上角，否则会和下面两个按钮挤成三行、右侧空一截 */}
        {!hub && whyToggle}
      </div>

      <div className={hub ? 'flex flex-wrap items-center gap-1' : 'mt-1.5 flex flex-wrap items-center gap-1'}>
        {hasProject && (
          <Button variant="primary" size="xs" onClick={onExport}>
            立即导出备份
          </Button>
        )}
        <Button variant="secondary" size="xs" onClick={onDismiss}>
          {hasProject ? '稍后再说' : '知道了'}
        </Button>
        {hub && whyToggle}
      </div>

      {open && (
        <div className={`basis-full space-y-1.5 border-t border-amber/20 pt-2 text-ink-400 ${hub ? 'mt-1.5 text-11' : 'mt-2 text-10'}`}>
          <p>
            <strong className="text-ink-200">自动备份 ≠ 备份。</strong>
            打开项目后每 {WEB ? 15 : 5} 分钟生成滚动备份（最多 {db.maxAutoBackups()} 份），每天首次打开还会生成每日备份（最多 {db.maxDailyBackups()} 份）。
            这些备份与作品共用存储区；存储区丢失时，内部备份也可能无法取回。
          </p>
          <p>
            自动备份只防「改坏了想回退」，防不了「整个容器没了」；后者只能靠导出到外部文件
            （U 盘 / 网盘 / 另一台机器），得到一个可随时「导入备份」还原的 JSON。
          </p>
          {!hasProject && (
            <p>在项目卡片右上角的菜单里点「导出备份」，每个项目导出一个 JSON 文件。</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function BackupReminder({
  variant, hasProject, isDemo = false, onExport,
}: {
  /** sidebar：项目内侧栏底部；hub：项目中心「我的作品」上方 */
  variant: 'sidebar' | 'hub'
  hasProject: boolean
  /** 当前打开的是示范项目 ⇒ 不提醒 */
  isDemo?: boolean
  onExport?: () => void
}) {
  const { due, dismiss, hide } = useBackupDue({ hasProject, isDemo })

  if (!due) return null

  return (
    <BackupNotice
      variant={variant}
      hasProject={hasProject}
      onExport={onExport ? () => { onExport(); hide() } : undefined}
      onDismiss={dismiss}
    />
  )
}
