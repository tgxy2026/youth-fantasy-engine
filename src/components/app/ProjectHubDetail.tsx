import {
  BookText, ChevronRight, Clock, FileText, FileUp, FolderOpen, History, Layers, Pencil, Shield, Trash2,
} from 'lucide-react'
import type * as db from '@/lib/db'
import type { BackupKind, BackupMeta } from '@/lib/db/backups'
import type { Project } from '@/lib/types'
import { normalizeGenrePack } from '@/lib/schemaTemplates/index'
import { Button } from '@/components/common/Button'
import SafeImage from '@/components/common/SafeImage'
import Tooltip from '@/components/common/Tooltip'
import ProjectAutoCover from '@/components/app/ProjectAutoCover'
import ReaderLaunchButton from '@/components/reader/ReaderLaunchButton'

export interface ProjectHubRow extends Project {
  stats?: db.ProjectStats
  /** 3.7.5：卡片简介位与搜索读的文案（《作品信息》正式简介 → 一句话简介 → 旧 `intro`） */
  introText?: string
}

const BACKUP_KIND_LABEL: Record<BackupKind, string> = {
  auto5min: '定时滚动备份',
  daily: '每日首次打开',
  manual: '手动备份',
  frozen: '定稿版本',
}

export function formatRelativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

function formatBackupTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Props {
  selected: ProjectHubRow
  recentBackups: BackupMeta[]
  onOpen: (projectId: string) => void
  onEdit: (project: ProjectHubRow) => void
  onExport: (project: ProjectHubRow) => void
  onExportCompendium: (project: ProjectHubRow) => void
  onOpenBackup: (project: ProjectHubRow) => void
  onDelete: (project: ProjectHubRow) => void
}

/**
 * 项目管理首页右侧详情工作台（从 ProjectHub 拆分）。
 * 保持「顶部 Bento 双列 + 底部最后编辑章节」框架不变，统一卡片材质、书封质感与排版层次。
 */
export default function ProjectHubDetail({
  selected,
  recentBackups,
  onOpen,
  onEdit,
  onExport,
  onExportCompendium,
  onOpenBackup,
  onDelete,
}: Props) {
  const auto5minBackups = recentBackups.filter(bk => bk.kind === 'auto5min')
  const dailyBackups = recentBackups.filter(bk => bk.kind === 'daily')
  const genreName = normalizeGenrePack(selected.genre)
  const isCustom = (selected.projectType ?? 'full') === 'custom'

  const titleSizeCls = selected.name.length <= 10
    ? 'text-[24px] 2xl:text-[28px] leading-snug'
    : selected.name.length <= 20
      ? 'text-[20px] 2xl:text-[23px] leading-snug'
      : 'text-[17px] 2xl:text-[19px] leading-snug'

  const renderBackupColumn = (
    title: string,
    items: BackupMeta[],
    emptyText: string,
  ) => (
    <div className="rounded-xl border border-ink-700/50 yfe-surface-3 px-3 py-2.5 flex flex-col min-h-0">
      <div className="flex items-center justify-between text-11 text-ink-400 mb-2 shrink-0">
        <span className="font-medium text-ink-200 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${items.length > 0 ? 'bg-amber/80' : 'bg-ink-600'}`} />
          {title}
        </span>
        <span className="ws-num text-ink-500">{items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <p className="text-11 text-ink-500 my-auto leading-relaxed">{emptyText}</p>
      ) : (
        <ul className="flex-1 min-h-0 max-h-[120px] overflow-y-auto divide-y divide-ink-700/45 pr-1">
          {items.map(bk => (
            <li
              key={bk.id}
              className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0 text-11 text-ink-300 ws-num hover:bg-ink-800/55 rounded-md px-1.5 -mx-1.5 transition-colors"
            >
              <Clock size={11} className="text-ink-500 shrink-0" />
              <span
                className="min-w-0 flex-1 truncate"
                title={`${formatBackupTime(bk.createdAt)} · ${bk.label || BACKUP_KIND_LABEL[bk.kind]}`}
              >
                {formatBackupTime(bk.createdAt)}
              </span>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onOpenBackup(selected)}
              >
                恢复
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div key={selected.id} data-project-card={selected.id} className="flex-1 min-h-0 flex flex-col">
      {/* ① 顶部 Bento 双列：左侧 Hero 展示卡 + 右侧四卡工作区 */}
      <section className="shrink-0 grid grid-cols-1 xl:grid-cols-[minmax(450px,510px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(500px,560px)_minmax(0,1fr)] gap-4 mb-4 items-stretch">
        {/* 左侧：Hero 展示卡（实体书封 + 作品名/元信息/简介引文框/主操作） */}
        <div className="rounded-2xl border border-ink-700/75 yfe-surface-2 backdrop-blur-md p-5 ws-surface relative overflow-hidden flex flex-col sm:flex-row items-stretch gap-5 min-w-0">
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'radial-gradient(110% 80% at 95% 0%, rgb(var(--amber) / 0.08), transparent 60%)' }}
          />

          {/* 实体书封容器 */}
          {selected.cover ? (
            <div className="relative w-[200px] h-[300px] 2xl:w-[228px] 2xl:h-[342px] mx-auto sm:mx-0 rounded-r-xl rounded-l-[5px] border border-ink-700/80 shrink-0 shadow-lg overflow-hidden transition-transform duration-300 hover:-translate-y-0.5">
              <SafeImage
                src={selected.cover}
                alt={selected.name}
                retry={false}
                className="w-full h-full object-cover"
              />
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-ink-950/35 via-ink-50/10 to-transparent pointer-events-none"
              />
              <div
                aria-hidden
                className="absolute inset-y-0 left-3 w-px bg-ink-700/40 pointer-events-none"
              />
            </div>
          ) : (
            <ProjectAutoCover
              name={selected.name}
              genre={selected.genre}
              size="lg"
              className="w-[200px] h-[300px] 2xl:w-[228px] 2xl:h-[342px] mx-auto sm:mx-0 shadow-lg transition-transform duration-300 hover:-translate-y-0.5"
            />
          )}

          {/* 作品信息列 */}
          <div className="relative min-w-0 flex-1 flex flex-col py-0.5">
            <h2 className={`${titleSizeCls} font-serif font-bold text-ink-50 tracking-wide break-words [overflow-wrap:anywhere]`}>
              {selected.name}
            </h2>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-11 text-ink-400 ws-num">
              <span className={`px-2 py-0.5 text-10 rounded-md border font-medium ${
                isCustom
                  ? 'border-amber/35 bg-amber/12 text-amber'
                  : 'border-ink-700 bg-ink-900/70 text-ink-200'
              }`}>
                {isCustom ? '自定义项目' : '完整项目'}
              </span>
              <span className="px-2 py-0.5 text-10 rounded-md border border-ink-700/75 bg-ink-900/55 text-ink-300">
                {genreName}
              </span>
              <span className="text-ink-400">创建于 {new Date(selected.createdAt).toLocaleDateString()}</span>
              <span className="text-ink-600">·</span>
              <span className="text-ink-400">最近活动 {formatRelativeDay(selected.updatedAt)}</span>
            </div>

            {/* 3.7.5：读《作品信息》的「正式简介 / 一句话简介」（正式优先），
                没填才回退项目记录上的旧 intro；两处都空才显示兜底提示。 */}
            <div className="mt-3.5 rounded-xl border border-ink-700/50 border-l-2 border-l-amber/50 yfe-surface-3 px-3.5 py-2.5 flex-1 min-h-0 max-h-[136px] overflow-y-auto">
              <p className="text-13 text-ink-200 leading-relaxed break-words whitespace-pre-line">
                {selected.introText
                  ? selected.introText
                  : <span className="text-ink-500">暂无简介，可在《作品信息》页的「一句话简介」或「正式简介」里填写。</span>}
              </p>
            </div>

            <div className="mt-auto pt-4 flex items-center gap-1 flex-wrap">
              <Button
                variant="primary"
                solid
                size="md"
                className="whitespace-nowrap !px-2 !text-12"
                onClick={() => onOpen(selected.id)}
                title="打开项目"
                aria-label="打开项目"
              >
                <FolderOpen size={14} /> 打开项目
              </Button>
              <Button
                variant="secondary"
                size="md"
                className="whitespace-nowrap !px-2 !text-12"
                onClick={() => onEdit(selected)}
                title="编辑项目"
                aria-label="编辑项目"
              >
                <Pencil size={13} /> 编辑项目
              </Button>
              {/* 3.7.5（Q-03）：第三个按钮进阅读模式 —— 与另两枚同高同风格，1440 宽下单行不换行不裁切 */}
              <ReaderLaunchButton
                projectId={selected.id}
                projectName={selected.name}
                mode="text"
                label="阅读"
                size="md"
                className="!px-2 !text-12"
              />
            </div>
          </div>
        </div>

        {/* 右侧：4 张卡（上排：作品概览 / 导出与备份 / 危险操作；下排：整宽两列最近自动备份） */}
        <div className="flex flex-col gap-3 min-w-0">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">
            {/* 1) 作品概览 */}
            <div className="rounded-2xl border border-ink-700/75 yfe-surface-2 backdrop-blur-md p-3.5 ws-surface flex flex-col">
              <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2 mb-2.5">
                <span className="w-6 h-6 rounded-lg bg-amber/12 text-amber flex items-center justify-center shrink-0">
                  <Layers size={13} />
                </span>
                <span>作品概览</span>
              </h3>
              <div className="grid grid-cols-2 gap-2 flex-1">
                <div className="rounded-xl border border-ink-700/55 yfe-surface-3 px-3 py-2 flex flex-col justify-center transition-colors hover:border-amber/35">
                  <div className="text-[20px] leading-tight font-bold text-ink-50 ws-num">{selected.stats?.volumes ?? 0}</div>
                  <div className="mt-0.5 text-10 text-ink-500">卷</div>
                </div>
                <div className="rounded-xl border border-ink-700/55 yfe-surface-3 px-3 py-2 flex flex-col justify-center transition-colors hover:border-amber/35">
                  <div className="text-[20px] leading-tight font-bold text-ink-50 ws-num">{selected.stats?.chapters ?? 0}</div>
                  <div className="mt-0.5 text-10 text-ink-500">章</div>
                </div>
                <div className="rounded-xl border border-ink-700/55 yfe-surface-3 px-3 py-2 flex flex-col justify-center transition-colors hover:border-amber/35">
                  <div className="text-[20px] leading-tight font-bold text-amber ws-num">{((selected.stats?.words ?? 0) / 10000).toFixed(1)}</div>
                  <div className="mt-0.5 text-10 text-ink-500">万字</div>
                </div>
                <div className="rounded-xl border border-ink-700/55 yfe-surface-3 px-3 py-2 flex flex-col justify-center min-w-0 transition-colors hover:border-amber/35">
                  <div className="text-13 leading-tight font-bold text-ink-100 truncate">{genreName}</div>
                  <div className="mt-0.5 text-10 text-ink-500">作品题材</div>
                </div>
              </div>
            </div>

            {/* 2) 导出与备份 */}
            <div className="rounded-2xl border border-ink-700/75 yfe-surface-2 backdrop-blur-md p-3.5 ws-surface flex flex-col">
              <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2 mb-2.5">
                <span className="w-6 h-6 rounded-lg bg-amber/12 text-amber flex items-center justify-center shrink-0">
                  <FileUp size={13} />
                </span>
                <span>导出与备份</span>
              </h3>
              <div className="flex flex-col gap-1.5 flex-1 justify-center">
                <Tooltip label="导出单本书完整 JSON 备份" className="w-full">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full !justify-between group"
                    onClick={() => onExport(selected)}
                    title="导出 JSON 备份"
                    aria-label="导出 JSON 备份"
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <FileUp size={13} className="text-amber shrink-0" />
                      <span className="truncate">导出 JSON 备份</span>
                    </span>
                    <ChevronRight size={12} className="text-ink-500 group-hover:text-amber group-hover:translate-x-0.5 transition-all shrink-0" />
                  </Button>
                </Tooltip>
                <Tooltip label="汇总全部世界观 / 人物 / 设定表" className="w-full">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full !justify-between group"
                    onClick={() => onExportCompendium(selected)}
                    title="导出设定集（汇总全部世界观 / 人物 / 设定表）"
                    aria-label="导出设定集"
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <BookText size={13} className="text-amber shrink-0" />
                      <span className="truncate">导出设定集</span>
                    </span>
                    <ChevronRight size={12} className="text-ink-500 group-hover:text-amber group-hover:translate-x-0.5 transition-all shrink-0" />
                  </Button>
                </Tooltip>
                <Tooltip label="查看 / 一键恢复历史自动备份" className="w-full">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full !justify-between group"
                    onClick={() => onOpenBackup(selected)}
                    title="备份与恢复：查看 / 一键恢复历史版本"
                    aria-label="备份与恢复"
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <History size={13} className="text-amber shrink-0" />
                      <span className="truncate">备份与恢复</span>
                    </span>
                    <ChevronRight size={12} className="text-ink-500 group-hover:text-amber group-hover:translate-x-0.5 transition-all shrink-0" />
                  </Button>
                </Tooltip>
              </div>
            </div>

            {/* 3) 危险操作 */}
            <div className="rounded-2xl border border-danger/30 bg-ink-850/88 backdrop-blur-md p-3.5 ws-surface relative overflow-hidden flex flex-col">
              <div aria-hidden className="absolute inset-0 bg-danger/[0.03] pointer-events-none" />
              <h3 className="relative text-12 font-semibold text-danger flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-lg bg-danger/12 text-danger flex items-center justify-center shrink-0">
                  <Trash2 size={13} />
                </span>
                <span>危险操作</span>
              </h3>
              <p className="relative text-11 text-ink-400 leading-relaxed mb-3">
                删除后《{selected.name}》的设定、大纲、正文与统计将一并移除且不可撤销，建议先导出 JSON 备份。
              </p>
              <Button
                variant="danger"
                size="sm"
                className="relative mt-auto w-full"
                onClick={() => onDelete(selected)}
                title="删除项目"
                aria-label="删除项目"
              >
                <Trash2 size={13} /> 删除项目
              </Button>
            </div>
          </div>

          {/* 4) 最近自动备份（占满右上整宽，双列展示 5 分钟定时与每日备份） */}
          <div className="rounded-2xl border border-ink-700/75 yfe-surface-2 backdrop-blur-md p-3.5 ws-surface flex-1 min-h-[164px] flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-2.5 shrink-0">
              <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-amber/12 text-amber flex items-center justify-center shrink-0">
                  <Shield size={13} />
                </span>
                <span>最近自动备份</span>
              </h3>
              <span className="px-2 py-0.5 rounded-full border border-ink-700/70 bg-ink-900/60 text-11 text-ink-400 ws-num">
                共 {auto5minBackups.length + dailyBackups.length} 份自动留存
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-h-0">
              {renderBackupColumn(
                '定时备份（每 5 分钟）',
                auto5minBackups,
                '暂无定时备份；编辑项目时每 5 分钟自动留存。',
              )}
              {renderBackupColumn(
                '每日备份',
                dailyBackups,
                '暂无每日备份；每日首次打开项目自动留存。',
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ② 下半部分：最后编辑的章节（拉高填满剩余可视高度，仅内部框滚动） */}
      <section className="flex-1 min-h-[240px] flex flex-col rounded-2xl border border-ink-700/75 yfe-surface-2 backdrop-blur-md p-4 ws-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5 shrink-0">
          <h3 className="text-12 font-semibold text-ink-200 flex items-center gap-2">
            <span className="w-6 h-6 rounded-lg bg-amber/12 text-amber flex items-center justify-center shrink-0">
              <FileText size={13} />
            </span>
            <span>最后编辑的章节</span>
          </h3>
          {selected.stats?.lastChapter && (
            <div className="flex flex-wrap items-center gap-2 text-11 text-ink-500 ws-num">
              {selected.stats.lastChapter.status && (
                <span className="px-2 py-0.5 rounded-md border border-ink-700 bg-ink-900/70 text-ink-300">
                  {selected.stats.lastChapter.status}
                </span>
              )}
              <span className="text-ink-300">{selected.stats.lastChapter.wordCount} 字</span>
              {selected.stats.lastChapter.updatedAt > 0 && (
                <>
                  <span>·</span>
                  <span>更新于 {formatBackupTime(selected.stats.lastChapter.updatedAt)}</span>
                </>
              )}
              <Button
                variant="primary"
                size="xs"
                onClick={() => onOpen(selected.id)}
                title="进入项目继续写作"
              >
                继续写作
              </Button>
            </div>
          )}
        </div>
        {!selected.stats?.lastChapter ? (
          <div className="flex-1 min-h-0 flex items-center justify-center rounded-xl border border-dashed border-ink-700/60 yfe-surface-3 px-4 py-6">
            <p className="text-12 text-ink-500">这本书还没有创建章节，打开项目后即可开始创作。</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 mb-2.5 shrink-0">
              <span className="w-[3px] h-4 rounded-full bg-amber/75 shrink-0" />
              <div className="font-serif text-15 font-bold text-ink-50 truncate">
                {selected.stats.lastChapter.title}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-ink-700/55 yfe-surface-3 px-6 py-4 font-serif text-14 text-ink-200 leading-[1.95] tracking-[0.015em] whitespace-pre-wrap break-words">
              {selected.stats.lastChapter.excerpt || '（本章暂未填写正文内容）'}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
