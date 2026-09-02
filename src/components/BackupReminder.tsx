import { useEffect, useState } from 'react'
import { FileDown } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { WEB, PORTABLE } from '../lib/env'
import * as db from '../lib/db'
import { isExportOverdue, isDismissExpired, markDismissed, REMIND_AFTER_DAYS } from '../lib/backupReminder'
import { isLocalDataNoticeActive } from './LocalDataNotice'

// #031 导出备份提醒：定期提醒用户把数据导出成外部文件，别让稿子只剩「同一个容器里」的那一份。
//
// 为什么需要它 —— 软件本身已有自动备份（每 5 分钟一份、每天一份，各留 30 份），
// 但自动备份写在**同一个存储里**（网页版 IndexedDB / 桌面与便携版的同一个 JSON 文件）。
// 也就是说：清站点数据、数据文件损坏、U 盘丢失、系统重装时，30 份自动备份会跟着一起消失。
// 自动备份只防「改坏了想回退」，防不了「整个容器没了」——这正是本提醒存在的理由。
//
// 触发条件（三条全满足才弹）：
//   ① 距上次导出备份已超过 REMIND_AFTER_DAYS 天（从未导出过则首次即弹）
//   ② 「稍后再说」的短期静默期已过
//   ③ 确有数据可丢（已打开项目，或项目列表非空）——新用户空库不打扰
// 网页版且未开启任何云端同步时不弹：那种情况 LocalDataNotice 每次打开都会弹且已含导出提醒，避免两个弹窗叠。

// #031 预留：网页版关服公告。待老大确定关服时间后，把公告文本填进这里，该段会自动出现在弹窗顶部高亮显示。
// 留空则不渲染——不把还没定下来的日期写进产品里。
const SHUTDOWN_NOTICE: string = ''

/** 数据存在哪（三端各异，文案随之变化） */
const STORAGE_DESC = WEB
  ? '浏览器本地数据库（IndexedDB）'
  : PORTABLE
    ? '便携版数据文件（你选的那个 .json）'
    : '本机数据文件'

/** 该端最常见的「容器一起没了」场景 */
const RISKS: string[] = WEB
  ? ['在浏览器设置或开发者工具里清除站点数据', '用无痕 / 隐私模式写作，关掉窗口数据即被清除', '更换浏览器、设备或系统用户，原设备的数据带不过去', '浏览器在磁盘紧张时回收不活跃站点的本地存储']
  : PORTABLE
    ? ['U 盘或移动硬盘丢失、损坏', '数据文件被误删或被杀毒软件隔离', '换电脑时忘了把数据文件一起拷走', '在网盘同步冲突时选错了覆盖方向']
    : ['数据文件被误删，或清理软件时一并清掉', '重装系统 / 更换电脑时未备份用户目录', '卸载软件时勾选了删除用户数据']

export default function BackupReminder({ hasProject, onExport }: { hasProject: boolean; onExport?: () => void }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      // 网页版未开启同步时，LocalDataNotice 每次都会弹且已讲导出，此处让位避免叠弹窗
      if (isLocalDataNoticeActive()) return
      if (!isExportOverdue() || !isDismissExpired()) return
      if (!hasProject) {
        const list = await db.getAllProjects().catch(() => [])
        if (!alive || list.length === 0) return // 一个项目都没有，没什么可备份的
      }
      if (alive) setShow(true)
    })()
    return () => {
      alive = false
    }
  }, [hasProject])

  const later = () => {
    markDismissed()
    setShow(false)
  }

  // 真正的导出由调用方完成（App 的 exportCurrent 会在下载成功后记录导出时间），此处只负责关窗
  const doExport = () => {
    onExport?.()
    setShow(false)
  }

  return (
    <Modal
      open={show}
      onClose={later}
      variant="plain"
      accent="amber"
      surface="900"
      width="lg"
      showCloseButton={false}
      titleSlot={
        <div className="flex items-center gap-2 text-amber">
          <FileDown size={18} />
          <span className="font-semibold">导出一份备份吧</span>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-ink-300 leading-relaxed">
        {SHUTDOWN_NOTICE && (
          <p className="rounded-lg bg-amber/10 border border-amber/40 p-3 text-amber">{SHUTDOWN_NOTICE}</p>
        )}

        <p>
          距你上次<strong className="text-ink-100">导出备份</strong>已经超过 {REMIND_AFTER_DAYS} 天了。
        </p>

        <div className="rounded-lg bg-ink-850 border border-ink-700 p-3">
          <p className="text-ink-200 font-medium mb-2">⚠️ 自动备份不等于备份</p>
          <p className="text-ink-400">
            软件每 5 分钟自动生成一份内部备份（最多保留 30 份），但它和你的数据一起存在
            <strong className="text-ink-200">{STORAGE_DESC}</strong>里。
            容器一旦没了，这 30 份会跟着一起消失。
          </p>
          <p className="text-ink-400 mt-2">
            自动备份只防「<span className="text-ink-300">改坏了想回退</span>」，
            防不了「<span className="text-amber">整个容器没了</span>」——后者只能靠导出到外部文件。
          </p>
        </div>

        <div>
          <p className="text-ink-200 font-medium mb-2">下面这些情况，数据会连内部备份一起丢：</p>
          <ul className="space-y-1.5 list-disc pl-5 text-ink-400">
            {RISKS.map(r => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>

        <p>
          导出得到的是一个标准 JSON 文件，<strong className="text-ink-100">存到 U 盘、网盘或另一台机器</strong>
          ，任何时候都能用「导入备份」原样还原。
        </p>

        <div className="rounded-lg bg-ink-850 border border-ink-700 p-3">
          <p className="text-ink-200 font-medium mb-2">怎么导出</p>
          {hasProject ? (
            <p className="text-ink-400">
              点下方按钮即可导出当前项目；平时也可以点左侧栏底部的
              <strong className="text-ink-200">「导出备份」</strong>。
            </p>
          ) : (
            <p className="text-ink-400">
              在项目卡片右上角的菜单里点<strong className="text-ink-200">「导出备份」</strong>
              ，每个项目导出一个 JSON 文件。
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-2 justify-end mt-5">
        {hasProject ? (
          <>
            <Button variant="ghost" onClick={later}>
              稍后再说
            </Button>
            <Button variant="primary" onClick={doExport}>
              立即导出备份
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={later}>
            知道了
          </Button>
        )}
      </div>
    </Modal>
  )
}
