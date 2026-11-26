/**
 * 启动异常 / 启动中的全屏基础态（3.7.4 从 App.tsx 抽出）。
 *
 * 只为把 App 的物理行数从硬闸 1200 附近拉开安全距离；
 * 文案、结构、无障碍属性与抽离前逐字一致。
 */
import type { ReactNode } from 'react'
import FailureNotice from '@/components/common/FailureNotice'
import { Button } from '@/components/common/Button'
import { DesktopWriteLockBanner } from '@/components/app/DesktopWriteLockBanner'
import { PortableWriteLockBanner } from '@/components/app/PortableWriteLockBanner'
import { foldVh } from '@/lib/settings/theme'

export function AppBootFailure({ cause, desktopOrPortable, onReload }: {
  cause: unknown
  desktopOrPortable: boolean
  onReload: () => void
}) {
  return (
    <>
      <DesktopWriteLockBanner />
      <PortableWriteLockBanner />
      <FailureNotice title="启动失败" error={cause}
        description="工作台尚未完成初始化。请保留技术摘要，再尝试重新加载。"
        actions={<Button variant="primary" size="md" onClick={onReload}>重新加载工作台</Button>}>
        {desktopOrPortable
          ? '当前页面尚未载入数据管理工具。需要排障时，请先通过系统文件管理器复制已有数据文件和备份，避免覆盖原文件。'
          : '请保留当前站点数据，避免直接清理浏览器存储。此时数据管理工具尚未载入，请勿依赖库内导出入口。'}
      </FailureNotice>
    </>
  )
}

export function AppBootLoading({ overlay }: { overlay?: ReactNode }) {
  return (
    <>
      <DesktopWriteLockBanner />
      <PortableWriteLockBanner />
      <main role="status" aria-label="正在打开创作工作台" className="flex flex-col items-center justify-center gap-2 bg-surface-app p-6 text-center" style={{ minHeight: foldVh('100vh') }}>
        <p className="text-14 font-semibold text-content-primary">正在打开创作工作台…</p>
        <p className="text-12 text-content-muted">正在读取工作台数据与设置，请稍候。</p>
      </main>
      {overlay}
    </>
  )
}