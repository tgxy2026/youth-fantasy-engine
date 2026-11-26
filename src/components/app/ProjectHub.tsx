import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import * as db from '@/lib/db'
import type { ProjectBundle } from '@/lib/db'
import { listBackups, type BackupKind, type BackupMeta } from '@/lib/db/backups'
import type { Project } from '@/lib/types'
import {
  BookPlus, FolderOpen, Trash2, FileUp, FileDown, FileText, X, Feather, Loader2, ImageIcon, Pencil, Check, BookText, History, ListChecks, Compass,
  BookOpen, MessagesSquare, Search, Clock, Shield, ChevronDown, Plus, Sparkles, Layers,
} from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import { lazyPage } from '@/components/common/LazyPage'
import { Modal } from '@/components/dialogs/Modal'
import SafeImage from '@/components/common/SafeImage'
import SelectRow from '@/components/common/SelectRow'
import Tooltip from '@/components/common/Tooltip'
import { Z } from '@/lib/app/zLayer'
// 3.5.0 · 投稿广场：项目中心入口（没有打开任何书时也能进广场）
import { openCommunity } from '@/lib/community/entry'
import BackupReminder from '@/components/app/BackupReminder'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import BrandMark from '@/components/common/BrandMark'
import { downloadBlob } from '@/lib/storage/zip'
import { markExported } from '@/lib/sync/backupReminder'
import { rebuildKbIndexAfterRestore } from '@/lib/search/kbRestoreIndex'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { usePersistedBool } from '@/lib/settings/uiPrefs'
import { LOCKED_IDS, DEFAULT_IDS } from '@/lib/schema'
import { DEFAULT_PACK, normalizeGenrePack, setActivePack, type GenrePack } from '@/lib/schemaTemplates/index'
import { getGenreToAIFor, setGenreToAIFor } from '@/lib/ai/aiGenreHint'
import { GenrePackSelect } from '@/components/creative/GenrePackSelect'
import workbenchBg from '@/assets/workbench-bg.png'
import { Button } from '@/components/common/Button'
import CloudSyncPanel from '@/components/app/CloudSyncPanel'
import { useImageDrop, DropOverlay } from '@/components/common/ImageDropZone'
import { appIconSupported } from '@/lib/app/desktop'
import { loadProjectIntroTexts } from '@/lib/app/projectIntroForm'

const HelpCenter = lazyPage(() => import('@/components/help/HelpCenter'), '帮助中心')
const BackupManager = lazyPage(() => import('@/components/app/BackupManager'), '备份管理')
const FeatureSelectModal = lazyPage(() => import('@/components/dialogs/FeatureSelectModal'), '功能选择')
const AppIconDialog = lazyPage(() => import('@/components/settings/AppIconDialog'), '应用图标')

interface Props {
  onOpen: (projectId: string) => void
  /**
   * 重新观看新手引导（A1 遗留补全）。
   * 向导本来只弹一次（写过 `welcomeDone` 就不再出现），这里给一条**重看的路子**；
   * 只切显示、不删任何数据 —— 重看时点「跳过，直接进入项目管理」即回到本页。
   */
  onReplayWelcome?: () => void
}

interface Row extends Project {
  stats?: db.ProjectStats
  /** 3.7.5：卡片简介位与搜索读的文案（《作品信息》正式简介 → 一句话简介 → 旧 `intro`） */
  introText?: string
}

type CreateType = 'full' | 'custom'
type FilterType = 'all' | 'full' | 'custom'
type SortKey = 'recent' | 'words' | 'created' | 'name'

const BACKUP_KIND_LABEL: Record<BackupKind, string> = {
  auto5min: '定时滚动备份',
  daily: '每日首次打开',
  manual: '手动备份',
  frozen: '定稿版本',
}

function formatRelativeDay(ts: number): string {
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

export default function ProjectHub({ onOpen, onReplayWelcome }: Props) {
  const [projects, setProjects] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<{ name: string; cover: string; projectType: CreateType; features: string[]; genre: GenrePack }>({ name: '', cover: '', projectType: 'full', features: [], genre: DEFAULT_PACK })
  const [busy, setBusy] = useState(false)
  /** 3.3.1 · P4：未打开项目也能读手册（规划 §4.3「项目管理页也提供手册入口」） */
  const [helpOpen, setHelpOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // 方案 D（目录 + 详情工作台）：左栏筛选 / 排序 / 当前选中作品
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [sortBy, setSortBy] = useState<SortKey>('recent')
  const [recentBackups, setRecentBackups] = useState<BackupMeta[]>([])
  // 🔴 2.7.2：`genre` 加进编辑表单 —— 题材改到「新建项目 / 编辑项目」两处选了，
  //    页签里不再提供切换 ⇒ 这里成了老项目改题材的**唯一入口**，不能缺。
  // 3.0：题材「要不要告诉 AI」—— 与题材同处一地（编辑项目是老项目改题材的唯一入口）。
  // 默认关（见 aiGenreHint）；读的是**被编辑的那个项目**，不是当前打开的项目。
  const [editForm, setEditForm] = useState<{ name: string; cover: string; genre: GenrePack; projectType: CreateType; features: string[]; genreToAI: boolean }>({ name: '', cover: '', genre: '东方修真', projectType: 'full', features: [], genreToAI: false })
  // 功能勾选弹窗：createFeatures / editFeatures 为初始勾选集合（不含锁定项），分别服务于"新建自定义"与"编辑自定义"
  const [featureModal, setFeatureModal] = useState<{ mode: 'create' | 'edit'; initial: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const coverRef = useRef<HTMLInputElement>(null)
  const editCoverRef = useRef<HTMLInputElement>(null)
  /**
   * 此刻正在编辑的项目 id（3.0）。
   *
   * 🔴 为什么不用 `editingId` 或书名做判据：读「把作品题材告诉 AI」是**异步**的，
   *    回来时要确认"还是那张卡片"。用 state 比会拿到闭包里的旧值；
   *    用书名比更糟 —— 作者点开编辑顺手改掉书名，回调就会被守卫拦下，
   *    开关停在"未勾选"而库里其实是开的（假象：设置丢了）。
   */
  const editPidRef = useRef<string | null>(null)
  const [backupPid, setBackupPid] = useState<string | null>(null)
  /** 顶栏「帮助」下拉菜单展开态（含「新手引导」「使用指南」） */
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  // 3.1.2 · 应用图标（桌面快捷方式）切换：入口只在**支持**的形态下出现
  //   （桌面安装版 + Windows 才有 .lnk；便携版 / 浏览器恒 false ⇒ 不显示按钮，而不是点了才报错）
  const [appIconOpen, setAppIconOpen] = useState(false)
  const [appIconOk, setAppIconOk] = useState(false)
  useEffect(() => { void appIconSupported().then(setAppIconOk) }, [])
  // 内置背景开关（2.6.1）：与侧栏弹窗同键，跨实例同步
  const [bgHidden] = usePersistedBool('workbench-bg-hidden', false)
  const [backupName, setBackupName] = useState('')

  const load = useCallback(async () => {
    const list = await db.getAllProjects()
    // 🔴 2026-09-22 六维审计 P2：改走批量版 —— 原先逐个 `getProjectStats` 是 N 项目 × 2 次全表读。
    const statsMap = await db.getProjectsStats(list.map(p => p.id))
    // 3.7.5：简介改读《作品信息》的「正式简介 / 一句话简介」，没填才回退旧 `intro`
    const introTexts = await loadProjectIntroTexts(list)
    const withStats = list.map(p => ({ ...p, stats: statsMap[p.id], introText: introTexts[p.id] ?? '' }))
    setProjects(withStats)
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

  const filteredProjects = useMemo(() => {
    const kw = query.trim().toLowerCase()
    const base = projects.filter(p => {
      if (filterType !== 'all' && (p.projectType ?? 'full') !== filterType) return false
      if (!kw) return true
      // 3.7.5：搜索也认《作品信息》里的简介（卡片显示的是它，搜不到就成了两套）
      return p.name.toLowerCase().includes(kw)
        || (p.introText ?? p.intro ?? '').toLowerCase().includes(kw)
    })
    return [...base].sort((a, b) => {
      if (sortBy === 'words') return (b.stats?.words ?? 0) - (a.stats?.words ?? 0)
      if (sortBy === 'created') return b.createdAt - a.createdAt
      if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh')
      return b.updatedAt - a.updatedAt
    })
  }, [projects, query, filterType, sortBy])

  const selected = useMemo(
    () => filteredProjects.find(p => p.id === selectedId) ?? filteredProjects[0] ?? null,
    [filteredProjects, selectedId],
  )

  useEffect(() => {
    if (filteredProjects.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !filteredProjects.some(p => p.id === selectedId)) {
      setSelectedId(filteredProjects[0].id)
    }
  }, [filteredProjects, selectedId])

  useEffect(() => {
    const pid = selected?.id
    if (!pid) {
      setRecentBackups([])
      return
    }
    let cancelled = false
    void listBackups(pid)
      .then(list => { if (!cancelled) setRecentBackups(list) })
      .catch(() => { if (!cancelled) setRecentBackups([]) })
    return () => { cancelled = true }
  }, [selected?.id, backupPid])

  const selectProject = (id: string) => {
    setSelectedId(id)
    if (creating) setCreating(false)
    if (editingId && editingId !== id) {
      editPidRef.current = null
      setEditingId(null)
    }
  }

  const pickCover = (file: File) => {
    if (file.size > 2 * 1024 * 1024) { showToast('封面图片请控制在 2MB 以内', 'error'); return }
    const reader = new FileReader()
    reader.onload = () => setForm(f => ({ ...f, cover: String(reader.result) }))
    reader.readAsDataURL(file)
  }

  const pickEditCover = (file: File) => {
    if (file.size > 2 * 1024 * 1024) { showToast('封面图片请控制在 2MB 以内', 'error'); return }
    const reader = new FileReader()
    reader.onload = () => setEditForm(f => ({ ...f, cover: String(reader.result) }))
    reader.readAsDataURL(file)
  }

  // 3.2.0：封面支持拖拽（新建弹窗 / 编辑弹窗各一处，落点就是那张 88×123 的封面位）。
  // 🔴 顺带补上一个老洞：`pickCover` 原先**只查体积不查类型**，选中一个 .txt 也会被 base64 进封面，
  //    现在非图片在 `planImageDrop` 就被挡下并说明原因。
  const dropCreateCover = useImageDrop({ accept: 'image/*', onFile: pickCover })
  const dropEditCover = useImageDrop({ accept: 'image/*', onFile: pickEditCover })

  const startEdit = (p: Row) => {
    const isCustom = (p.projectType ?? 'full') === 'custom'
    setEditForm({
      name: p.name, cover: p.cover ?? '',
      genre: normalizeGenrePack(p.genre),
      projectType: isCustom ? 'custom' : 'full', features: p.features ?? [],
      // 先按默认（关）渲染，读到真值再补 —— 读设置是异步的，不该把弹开卡片卡住
      genreToAI: false,
    })
    setSelectedId(p.id)
    setCreating(false)
    setEditingId(p.id)
    editPidRef.current = p.id
    // 🔴 用 pid 版：这里编辑的**不一定是当前打开的项目**（`db.getSetting` 会读错那本）
    void getGenreToAIFor(p.id).then(v => {
      // 期间可能已经切到别的卡片 / 关掉编辑态 ⇒ 丢弃这次结果（按 pid 认，不看书名）
      if (editPidRef.current !== p.id) return
      setEditForm(f => ({ ...f, genreToAI: v }))
    })
  }

  const saveEdit = async () => {
    if (!editingId) return
    if (!editForm.name.trim()) { showToast('请输入书名', 'error'); return }
    setBusy(true)
    try {
      const patch: Partial<Project> & { id: string } = { id: editingId, name: editForm.name.trim(), cover: editForm.cover }
      // 🔴 题材变更要落库（下次打开才知道用哪套示例）；顺带刷模块级状态，当前窗口立刻生效
      if (editForm.genre) {
        patch.genre = editForm.genre
        setActivePack(editForm.genre)
      }
      if (editForm.projectType === 'custom') patch.features = editForm.features
      await db.updateProject(patch)
      // 3.0：题材「告诉 AI」开关（项目级）。先落项目记录，再写设置 —— 顺序无关，
      // 但两处都失败要给出同一句话，故放在同一个 try 里。
      await setGenreToAIFor(editingId, editForm.genreToAI)
      editPidRef.current = null
      setEditingId(null)
      await load()
    } catch (e) {
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!form.name.trim()) { showToast('请输入书名', 'error'); return }
    if (form.projectType === 'custom' && form.features.length === 0) { showToast('请先选择要启用的功能模块', 'error'); return }
    setBusy(true)
    try {
      // 题材（2.7.1）：写进 Project.genre ⇒ 决定「世界设定 / 力量体系 / 制度页签」用哪套模板。
      // 值就是四字包名（见 lib/schemaTemplates），故 AI 注入「类型：东方修真」天然可读。
      const p = await db.createProject(
        form.name.trim(), form.genre, '', form.cover, form.projectType,
        form.projectType === 'custom' ? form.features : undefined,
      )
      setCreating(false)
      setForm({ name: '', cover: '', projectType: 'full', features: [], genre: DEFAULT_PACK })
      onOpen(p.id)
    } catch (e) {
      showToast('创建失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const createDemo = async () => {
    if (!await confirmDialog({
      title: '创建示范项目',
      message: '创建示范项目「吞天神脉」？\n将写入示例宇宙（陈渊·苍澜大陆）的全部范例数据：两卷二十章正文（约九万字）、设定表单、角色卡、伏笔、时间脉络、码字统计，以及酒馆模式的背景设定与一个可直接开演的剧情推演场景。可用于体验和测试各项功能。',
    })) return
    setBusy(true)
    try {
      const { createDemoProject } = await import('@/lib/app/seedData')
      const id = await createDemoProject()
      setBusy(false)
      onOpen(id)
    } catch (e) {
      setBusy(false)
      showToast(`创建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const removeProject = async (p: Row) => {
    if (!await confirmDialog({ title: '删除项目', message: `确定删除项目「${p.name}」？\n其全部设定、大纲与正文将一并删除，不可恢复！\n建议先导出备份。`, danger: true })) return
    await db.deleteProject(p.id)
    await load()
  }

  const exportProject = async (p: Row) => {
    const bundle = await db.exportProject(p.id)
    downloadBlob(
      `青春幻想引擎备份-${p.name}-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    )
    // OPT-011：这是**单本书**备份（不是整库）—— 说清去哪导入，避免用户拿去
    // 数据坞的「导入数据文件」被拒后卡住（2026-10-19 社区反馈复现结论）
    showToast(`已导出《${p.name}》备份（单本书）。\n换设备还原请用「项目中心」的「导入项目」；整体搬迁请用左下角数据坞的「导出全部数据」。`, 'success', 7000)
    markExported() // #031：记录「已导出到外部文件」，提醒据此重新计时
  }

  const importProject = async (file: File) => {
    try {
      const text = await file.text()
      const bundle = JSON.parse(text) as ProjectBundle
      const id = await db.importProject(bundle)
      void rebuildKbIndexAfterRestore(id)
      showToast(`项目「${bundle.project?.name ?? ''}」导入成功`)
      onOpen(id)
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  if (!loaded) {
    return <div className="h-screen flex items-center justify-center text-ink-400 text-sm gap-2"><Loader2 size={14} className="animate-spin" /> 加载中…</div>
  }

  const editingProject = editingId ? projects.find(p => p.id === editingId) ?? null : null
  const closeEdit = () => { editPidRef.current = null; setEditingId(null) }

  const listGroups = sortBy === 'recent'
    ? [{ key: 'recent', label: '最近活动', items: filteredProjects }]
    : [
        { key: 'full', label: '完整项目', items: filteredProjects.filter(p => (p.projectType ?? 'full') === 'full') },
        { key: 'custom', label: '自定义项目', items: filteredProjects.filter(p => (p.projectType ?? 'full') === 'custom') },
      ].filter(g => g.items.length > 0)

  return (
    <div data-project-hub className="min-h-screen lg:h-[calc(100vh/var(--ui-zoom,1))] bg-transparent overflow-y-auto lg:overflow-hidden relative flex flex-col">
      {/* 与项目内页一致：金色线稿背景，透明底、置于最底层从半透明面板后透出（2.6.1 起受侧栏「背景」开关控制） */}
      {!bgHidden && (
        <div
          className="absolute inset-0 pointer-events-none bg-cover bg-center bg-no-repeat opacity-100"
          style={{ backgroundImage: `url(${workbenchBg})`, zIndex: Z.pageBackdrop }}
          aria-hidden
        />
      )}

      {/* 工坊顶栏（对齐方案 D：极简 5 控件） */}
      <header
        className="relative shrink-0 border-b border-ink-700/60 bg-ink-950/60 backdrop-blur-sm px-5 lg:px-7 py-3 flex flex-wrap items-center justify-between gap-3"
        style={{ zIndex: Z.pagePanel }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="inline-flex items-center justify-center w-[34px] h-[34px] rounded-[10px] bg-amber/12 border border-amber/30 shrink-0">
            <BrandMark size={18} className="text-amber" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-ink-50 tracking-tight flex items-baseline gap-1.5">
              青春幻想引擎
              <span className="text-11 font-normal text-ink-500 ws-num">{APP_VERSION_LABEL}</span>
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center justify-end">
          <Button variant="secondary" size="md" onClick={createDemo} disabled={busy} title="一键创建含完整示例数据的测试项目">
            <BookPlus size={14} /> 创建示范项目
          </Button>
          <Button variant="secondary" size="md" onClick={() => fileRef.current?.click()}>
            <FileDown size={14} /> 导入已有项目
          </Button>
          {/* 3.5.0 · 投稿广场：不依赖打开任何一本书；未登录可浏览，登录后才能投稿 */}
          <Button variant="secondary" size="md" onClick={openCommunity} title="打开投稿广场（可浏览、投稿、评论与排行）">
            <MessagesSquare size={14} /> 投稿广场
          </Button>
          <CloudSyncPanel inline block={false} showState={false} size="md" onProjectsChanged={load} />
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) importProject(f)
              e.target.value = ''
            }}
          />
          {appIconOk && (
            <Button
              variant="secondary"
              size="md"
              onClick={() => setAppIconOpen(true)}
              title="应用图标：切换桌面快捷方式的图标（桌面 / 开始菜单同时生效）"
            >
              <ImageIcon size={14} /> <span>应用图标</span>
            </Button>
          )}

          <div className="relative">
            <Button
              variant="secondary"
              size="md"
              onClick={() => setHelpMenuOpen(o => !o)}
              title="帮助：新手引导、使用指南"
              aria-haspopup="menu"
              aria-expanded={helpMenuOpen}
              className="flex items-center gap-1.5"
            >
              <Compass size={14} /> 帮助
              <ChevronDown size={11} className="opacity-70" />
            </Button>
            {helpMenuOpen && (
              <>
                <div className="fixed inset-0" style={{ zIndex: Z.pagePanel }} onClick={() => setHelpMenuOpen(false)} aria-hidden />
                <div
                  className="absolute right-0 top-full mt-1.5 min-w-[196px] bg-ink-850 border border-ink-700 rounded-[10px] shadow-2xl p-1.5 ws-surface"
                  style={{ zIndex: Z.pagePanelTop }}
                  role="menu"
                >
                  {onReplayWelcome && (
                    <Button variant="bare" role="menuitem"
                      onClick={() => { setHelpMenuOpen(false); onReplayWelcome() }}
                      className="w-full !justify-start px-2.5 py-1.5 rounded-md text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      title="重新看一遍新手引导（三选一 + 顺手指引）—— 不会改动任何已有数据"
                    >
                      <Compass size={12} className="text-amber shrink-0" />
                      <span className="flex-1 min-w-0 text-left whitespace-nowrap">新手引导</span>
                    </Button>
                  )}
                  <Button variant="bare" role="menuitem"
                    onClick={() => { setHelpMenuOpen(false); setHelpOpen(true) }}
                    className="w-full !justify-start px-2.5 py-1.5 rounded-md text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                    title="不用打开项目也能查使用手册、问功能用法"
                  >
                    <BookOpen size={12} className="text-amber shrink-0" />
                    <span className="flex-1 min-w-0 text-left whitespace-nowrap">使用指南</span>
                  </Button>
                </div>
              </>
            )}
          </div>

          <Button
            variant="primary"
            solid
            size="md"
            onClick={() => { editPidRef.current = null; setEditingId(null); setCreating(true) }}
            className="font-medium"
          >
            <Plus size={14} /> 新建小说项目
          </Button>
        </div>
      </header>

      {/* 方案 D 主分栏：左侧 340px 目录 + 右侧工作台详情 */}
      <div className="relative flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]" style={{ zIndex: Z.pageHandle }}>
        {/* 左栏：作品目录（搜索 / 排序 / 胶囊筛选 + 独立滚动） */}
        <aside className="border-b lg:border-b-0 lg:border-r border-ink-700/60 bg-ink-950/55 flex flex-col min-h-0 max-h-[340px] lg:max-h-none">
          <div className="px-3.5 pt-3.5 pb-2.5 space-y-2.5 shrink-0">
            <div className="flex items-center gap-2">
              <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg border border-ink-700/80 bg-ink-900/80 px-2.5 h-[34px] focus-within:border-amber/55">
                <Search size={13} className="text-ink-500 shrink-0" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="搜索书名或简介…"
                  aria-label="搜索作品"
                  className="w-full min-w-0 !bg-transparent !border-0 !p-0 !ring-0 text-12 text-ink-100 placeholder:text-ink-500 focus:outline-none"
                />
                {query && (
                  <Button variant="icon-muted" size="xs" iconOnly onClick={() => setQuery('')} title="清空搜索" aria-label="清空搜索">
                    <X size={12} />
                  </Button>
                )}
              </label>
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as SortKey)}
                aria-label="排序方式"
                className="h-[34px] rounded-lg border border-ink-700/80 bg-ink-900/80 px-2.5 text-12 text-ink-200 shrink-0"
              >
                <option value="recent">最近活动</option>
                <option value="words">字数</option>
                <option value="created">创建时间</option>
                <option value="name">书名</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div
                className="inline-flex items-center p-[3px] gap-0.5 rounded-[9px] border border-ink-700/70 bg-ink-900/80"
                role="group"
                aria-label="按项目形态筛选"
              >
                {([
                  { k: 'all', label: '全部' },
                  { k: 'full', label: '完整' },
                  { k: 'custom', label: '自定义' },
                ] as const).map(opt => (
                  <Button
                    key={opt.k}
                    variant="toggle"
                    size="xs"
                    selected={filterType === opt.k}
                    onClick={() => setFilterType(opt.k)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
              <h2 className="text-11 font-medium text-ink-400 flex items-center gap-1 shrink-0">
                <Sparkles size={12} className="text-amber" />
                <span>我的作品 (<span className="ws-num">{projects.length}</span>)</span>
                <HelpPopover title="项目管理怎么用" width="22rem" size={12}>
                  {'一本书 = 一个独立项目，设定 / 大纲 / 正文 / 统计互不干扰。\n\n· 新建小说项目：只需书名即可开工，封面与其他信息随时可补；\n· 创建示范项目：一键写入完整范例数据（卷章正文、设定表单、角色卡、伏笔、时间脉络、码字统计），用来快速摸清各功能怎么用，体验完可直接删除；\n· 导入已有项目：选择之前导出的 .json 备份即可还原全部内容；\n· 备份：把某本书导出成 .json 文件，换设备或重装前务必先导一份；导入已有项目可选择之前的 .json 备份还原；\n· 设定集：一键导出汇总全书世界观 / 人物 / 设定表的 Markdown 文档；\n· 备份与恢复：查看打开项目时自动生成的备份（定时滚动与每日首次打开各一类），可一键恢复历史版本；\n· 打开项目：进入该书的完整创作面板。'}
                </HelpPopover>
              </h2>
            </div>
          </div>

          <div
            className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2 space-y-1"
            style={{ paddingBottom: 'min(calc(var(--dock-height, 0px) + 2.5rem), 340px)' }}
          >
            {projects.length === 0 ? (
              <div className="mx-1 my-3 rounded-xl border border-dashed border-ink-700/80 px-4 py-8 text-center text-12 text-ink-500">
                暂无作品
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="mx-1 my-3 rounded-xl border border-dashed border-ink-700/80 px-4 py-8 text-center text-12 text-ink-500">
                没有匹配的作品
              </div>
            ) : (
              listGroups.map(group => (
                <div key={group.key} className="mb-1.5">
                  <div className="px-2 pt-2.5 pb-1.5 text-10 tracking-wider text-ink-500 flex items-center gap-1.5">
                    <span>{group.label}</span>
                    <span className="px-1.5 py-px rounded bg-ink-800/90 text-ink-400 border border-ink-700/70 ws-num">{group.items.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map(p => {
                      const active = !creating && selected?.id === p.id
                      return (
                        <SelectRow
                          key={p.id}
                          selected={active}
                          variant="outline"
                          onClick={() => selectProject(p.id)}
                          onDoubleClick={() => onOpen(p.id)}
                          title={`${p.name}（双击直接打开）`}
                          className="items-center gap-3 rounded-[10px] px-2.5 py-2"
                        >
                          {p.cover ? (
                            <SafeImage src={p.cover} alt={p.name} retry={false} className="w-9 h-[52px] object-cover rounded-md border border-ink-700/80 shrink-0" />
                          ) : (
                            <div className="w-9 h-[52px] rounded-md border border-dashed border-ink-700/80 bg-ink-800/50 shrink-0 flex items-center justify-center text-ink-600">
                              <Feather size={13} />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-13 font-semibold text-ink-100 truncate">{p.name}</div>
                            <div className="mt-0.5 text-11 text-ink-500 ws-num truncate">
                              {p.stats?.chapters ?? 0} 章 · {((p.stats?.words ?? 0) / 10000).toFixed(1)} 万字 · {formatRelativeDay(p.updatedAt)}
                            </div>
                          </div>
                        </SelectRow>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* 右栏：工作台详情区（自适应视口铺满，正文章节在内部框体滚动，不产生多余整页滚动条） */}
        <main className="min-w-0 min-h-0 flex flex-col lg:overflow-y-auto px-5 lg:px-8 pt-5 pb-5 page-enter">
          <div className="w-full flex-1 min-h-0 flex flex-col">
            <BackupReminder variant="hub" hasProject={false} />

            {/* 新建表单 */}
            {creating ? (
              <div className="mb-6 rounded-xl border border-amber/25 bg-ink-850/95 p-5 ws-surface page-enter">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-14 font-semibold text-ink-100">新建小说项目</h3>
                  <Button variant="icon-muted" onClick={() => setCreating(false)} title="关闭" aria-label="关闭"><X size={16} /></Button>
                </div>
                <div className="flex flex-col sm:flex-row gap-5">
                  {/* 封面上传（也可把图片直接拖到这张封面位上） */}
                  <div className="relative shrink-0" {...dropCreateCover.dropProps}>
                    <Button variant="bare"
                      onClick={() => coverRef.current?.click()}
                      className="group relative w-[88px] h-[123px] rounded-lg border border-dashed border-ink-600 hover:border-amber/50 overflow-hidden transition-colors flex items-center justify-center"
                      title="上传封面（可选，2MB 以内；也可以把图片直接拖到这里）"
                    >
                      {form.cover ? (
                        <>
                          <SafeImage src={form.cover} alt="封面预览" retry={false} className="w-full h-full object-cover" />
                          <span
                            onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, cover: '' })) }}
                            className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white/90 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="移除封面"
                          >
                            <X size={11} />
                          </span>
                        </>
                      ) : (
                        <div className="flex flex-col items-center gap-1.5 text-ink-500 group-hover:text-amber/70 transition-colors">
                          <ImageIcon size={20} />
                          <span className="text-10">上传封面</span>
                        </div>
                      )}
                    </Button>
                    {dropCreateCover.dragging && <DropOverlay compact label="松开上传" />}
                    <input
                      ref={coverRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (f) pickCover(f)
                        e.target.value = ''
                      }}
                    />
                  </div>
                  {/* 书名 + 创建 */}
                  <div className="flex-1 flex flex-col gap-3 min-w-0">
                    {/* 项目形态：完整 / 自定义 */}
                    <div>
                      <label className="text-11 text-ink-400 mb-1 block flex items-center gap-1">项目形态
                        <HelpPopover title="项目形态怎么选" width="23rem" size={11}>
                          {'新建时选择完整项目或自定义项目。自定义项目创建后可在「编辑项目」调整功能清单。\n\n· 完整项目：功能最全，适合中长篇连载——含全部设定表（力量体系、人物关系、国家 / 地理 / 种族 / 物品设定、历史事件、伏笔、时间脉络、知情权限、分卷大纲、设定变更等）与灵感 / 检查工具；\n· 自定义项目：从完整项目功能全集里自由勾选要启用的模块（工作面板里的「写作面板 / 模型设置 / 使用指南 / 关于打赏」、正文写作，以及灵感工具里的「灵感启发 / 素材资料 / 检查工具」为必选、不可取消，拆书与创意写作默认不勾选、需要时单独勾上；备份与恢复 / 全文检索 / 设定检索为全局基础设施、始终常开（不进入清单、不可取消）；其余模块自由勾选）。拿不准就选「完整项目」，用不到的模块不填即可。'}
                        </HelpPopover>
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2">
                        {([
                          { v: 'full' as const, label: '完整项目', desc: '适合中长篇连载·功能最完整，开箱即用' },
                          { v: 'custom' as const, label: '自定义项目', desc: '从功能全集里自由勾选要启用的模块' },
                        ]).map(opt => {
                          const active = form.projectType === opt.v
                          return (
                            <Button variant="toggle" selected={active}
                              key={opt.v}
                              type="button"
                              onClick={() => {
                                if (opt.v === 'custom' && form.projectType !== 'custom') {
                                  setForm(f => ({ ...f, projectType: 'custom', features: [] }))
                                  setFeatureModal({ mode: 'create', initial: DEFAULT_IDS })
                                } else {
                                  setForm(f => ({ ...f, projectType: opt.v }))
                                }
                              }}
                              className="flex-1 text-left px-3 py-2 rounded-lg border hover:border-ink-500"
                              title={opt.desc}
                            >
                              <div className="text-12 font-medium">{opt.label}</div>
                              <div className="text-10 text-ink-500 mt-0.5">{opt.desc}</div>
                            </Button>
                          )
                        })}
                      </div>
                      {form.projectType === 'custom' && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <Button variant="secondary" type="button" onClick={() => setFeatureModal({ mode: 'create', initial: form.features.length ? form.features.filter(id => !LOCKED_IDS.includes(id)) : DEFAULT_IDS })} className="flex items-center gap-1.5 rounded-lg transition-colors">
                            <ListChecks size={13} /> {form.features.length ? `已选 ${form.features.length} 个功能 · 重新选择` : '选择功能模块'}
                          </Button>
                          {form.features.length > 0 && (
                            <span className="text-11 text-ink-500">含必选模块与依赖自动带入项，共 {form.features.length} 项</span>
                          )}
                        </div>
                      )}
                    </div>
                    {/* 作品题材（2.7.1 建 · 2.7.2 改口径）：只决定各页签里的字段名与示例怎么写。
                        🔴 2.7.2 主人定案：题材**不再决定页签显隐**（完整项目全部显示、自定义项目按勾选），
                           也不在页签里提供切换（改题材回项目管理页「编辑项目」）。 */}
                    <div>
                      <label className="text-11 text-ink-400 mb-1 flex items-center gap-1">作品题材
                        <HelpPopover title="作品题材怎么选" width="23rem" size={11}>
                          {'题材会改变适用表单的填写说明与示例。\n\n'
                            + '· 选「历史古代」，「政治架构」里的示例会是「九品十八级、府兵制、刑部大理寺」；\n'
                            + '· 选「科幻末世」，同一批字段的示例会变成「联交所、行星防卫军、生态舱配给」。\n\n'
                            + '📌 它「不影响页签数量」 —— 完整项目的《开书定位》六个页签全部显示；'
                            + '自定义项目则按你在「功能模块」里勾的来。\n'
                            + '📌 选错了不要紧：回项目管理页「编辑项目」能改，填过的内容不会丢（换题材只换示例，不动字段名）。\n\n'
                            + '它「默认不会告诉 AI」 —— 题材不进模型看到的资料，AI 不会因为看到「类型：都市异能」'
                            + '就照题材套路发挥。想让它知道：回「编辑项目」打开「把作品题材告诉 AI」，'
                            + '或直接填《作品信息》页的「类型赛道」字段（当任务带入作品信息时，可按资料范围发送你填的描述）。'}
                        </HelpPopover>
                      </label>
                      <GenrePackSelect value={form.genre} onChange={g => setForm(f => ({ ...f, genre: g }))} className="w-full" />
                    </div>
                    <div className="flex-1">
                      <label htmlFor="create-project-name" className="text-11 text-ink-400 mb-1 block">书名 *</label>
                      <input
                        id="create-project-name"
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) create() }}
                        placeholder="给这本书起个名字，其他信息之后随时可以补"
                        autoFocus
                        className="w-full text-13"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button onClick={create}
                        disabled={busy} variant="primary" solid size="md">
                        {busy ? '创建中…' : '创建并进入项目'}
                      </Button>
                      <Button variant="secondary" size="md" onClick={() => setCreating(false)}>
                        取消
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : projects.length === 0 ? (
              <div className="min-h-[55vh] flex items-center justify-center">
                <div className="text-center max-w-md px-4">
                  <BookPlus size={40} className="mx-auto text-ink-500 mb-3" />
                  <h2 className="text-xl font-semibold text-ink-100">还没有作品，开启第一本书</h2>
                  <p className="mt-2 text-12 text-ink-400 leading-relaxed">
                    只需要书名即可开工。想先摸清各功能？创建一个带完整范例数据的示范项目，体验完可直接删除。
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                    <Button variant="primary" solid size="md" onClick={() => setCreating(true)}>
                      <Plus size={14} /> 新建小说项目
                    </Button>
                    <Button variant="secondary" size="md" onClick={createDemo} disabled={busy}>
                      <BookPlus size={14} /> 创建示范项目
                    </Button>
                    <Button variant="secondary" size="md" onClick={() => fileRef.current?.click()}>
                      <FileDown size={14} /> 导入已有项目
                    </Button>
                  </div>
                </div>
              </div>
            ) : !selected ? (
              <div className="min-h-[45vh] flex items-center justify-center">
                <div className="text-center px-4">
                  <Search size={28} className="mx-auto text-ink-600 mb-3" />
                  <div className="text-14 font-semibold text-ink-200">没有符合条件的作品</div>
                  <div className="mt-1.5 text-12 text-ink-500">调整左侧搜索关键词或形态筛选后再看</div>
                  <Button variant="secondary" size="sm" className="mt-4" onClick={() => { setQuery(''); setFilterType('all') }}>
                    重置筛选
                  </Button>
                </div>
              </div>
            ) : (
              <div key={selected.id} data-project-card={selected.id} className="flex-1 min-h-0 flex flex-col">
                {/* ① 顶部 Bento 双列：左侧大封面 + 紧凑作品头，右侧四卡工作区（上排三卡 + 下排整宽两列自动备份） */}
                {(() => {
                  const auto5minBackups = recentBackups.filter(bk => bk.kind === 'auto5min')
                  const dailyBackups = recentBackups.filter(bk => bk.kind === 'daily')
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
                    <div className="rounded-lg border border-ink-700/55 bg-ink-900/45 px-3 py-2 flex flex-col min-h-0">
                      <div className="flex items-center justify-between text-11 text-ink-400 mb-1.5 shrink-0">
                        <span className="font-medium text-ink-300">{title}</span>
                        <span className="ws-num text-ink-500">{items.length} 条</span>
                      </div>
                      {items.length === 0 ? (
                        <p className="text-11 text-ink-500 my-auto leading-relaxed">{emptyText}</p>
                      ) : (
                        <ul className="flex-1 min-h-0 max-h-[120px] overflow-y-auto divide-y divide-ink-700/50 pr-1">
                          {items.map(bk => (
                            <li key={bk.id} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0 text-11 text-ink-300 ws-num">
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
                                onClick={() => { setBackupName(selected.name); setBackupPid(selected.id) }}
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
                    <section className="shrink-0 grid grid-cols-1 xl:grid-cols-[minmax(440px,490px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(480px,540px)_minmax(0,1fr)] gap-5 mb-4 items-stretch">
                      {/* 左侧：放大封面 + 自适应换行的作品名/元信息/简介/单行主操作 */}
                      <div className="flex flex-col sm:flex-row items-stretch gap-5 min-w-0">
                        {selected.cover ? (
                          <SafeImage
                            src={selected.cover}
                            alt={selected.name}
                            retry={false}
                            className="w-[212px] h-[318px] 2xl:w-[240px] 2xl:h-[360px] mx-auto sm:mx-0 object-cover rounded-xl border border-ink-700/80 shrink-0 shadow-md shadow-black/25"
                          />
                        ) : (
                          <div className="w-[212px] h-[318px] 2xl:w-[240px] 2xl:h-[360px] mx-auto sm:mx-0 rounded-xl border border-dashed border-ink-700/80 bg-gradient-to-b from-ink-800/55 to-ink-900/55 shrink-0 flex flex-col items-center justify-center gap-2.5 text-ink-600 shadow-inner">
                            <Feather size={34} />
                            <span className="text-12 text-ink-500">未设封面</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1 flex flex-col py-0.5">
                          <h2 className={`${titleSizeCls} font-bold text-ink-50 tracking-wide break-words [overflow-wrap:anywhere]`}>
                            {selected.name}
                          </h2>
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-12 text-ink-400 ws-num">
                            <span className={`px-2 py-0.5 text-10 rounded-[5px] border ${(selected.projectType ?? 'full') === 'custom' ? 'border-amber/35 bg-amber/10 text-amber' : 'border-ink-700 bg-ink-800/90 text-ink-300'}`}>
                              {(selected.projectType ?? 'full') === 'custom' ? '自定义项目' : '完整项目'}
                            </span>
                            <span>创建于 {new Date(selected.createdAt).toLocaleDateString()}</span>
                            <span>最近活动 {formatRelativeDay(selected.updatedAt)}</span>
                          </div>
                          {/* 3.7.5：读《作品信息》的「正式简介 / 一句话简介」（正式优先），
                              没填才回退项目记录上的旧 intro；两处都空才显示兜底提示。 */}
                          <p className="mt-3.5 text-13 text-ink-300 leading-relaxed flex-1 min-h-0 max-h-[120px] overflow-y-auto pr-1 break-words whitespace-pre-line">
                            {selected.introText ? selected.introText : <span className="text-ink-500">暂无简介，可在《作品信息》页的「一句话简介」或「正式简介」里填写。</span>}
                          </p>
                          <div className="mt-auto pt-4 flex items-center gap-2.5 flex-nowrap">
                            <Button
                              variant="primary"
                              solid
                              size="md"
                              className="whitespace-nowrap px-4"
                              onClick={() => onOpen(selected.id)}
                              title="打开项目"
                              aria-label="打开项目"
                            >
                              <FolderOpen size={15} /> 打开项目
                            </Button>
                            <Button
                              variant="secondary"
                              size="md"
                              className="whitespace-nowrap px-4"
                              onClick={() => startEdit(selected)}
                              title="编辑项目"
                              aria-label="编辑项目"
                            >
                              <Pencil size={14} /> 编辑项目
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* 右侧：4 张卡（上排：作品概览 / 导出与备份 / 危险操作；下排：整宽两列最近自动备份） */}
                      <div className="flex flex-col gap-3 min-w-0">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">
                          {/* 1) 作品概览 */}
                          <div className="rounded-xl border border-ink-700/75 bg-ink-850/90 p-3.5 ws-surface flex flex-col">
                            <h3 className="text-12 font-semibold text-ink-300 flex items-center gap-1.5 mb-2.5">
                              <Layers size={13} className="text-amber" /> 作品概览
                            </h3>
                            <div className="grid grid-cols-2 gap-2 flex-1">
                              <div className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-2.5 py-1.5 flex flex-col justify-center">
                                <div className="text-[18px] leading-tight font-bold text-ink-50 ws-num">{selected.stats?.volumes ?? 0}</div>
                                <div className="mt-0.5 text-10 text-ink-500">卷</div>
                              </div>
                              <div className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-2.5 py-1.5 flex flex-col justify-center">
                                <div className="text-[18px] leading-tight font-bold text-ink-50 ws-num">{selected.stats?.chapters ?? 0}</div>
                                <div className="mt-0.5 text-10 text-ink-500">章</div>
                              </div>
                              <div className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-2.5 py-1.5 flex flex-col justify-center">
                                <div className="text-[18px] leading-tight font-bold text-ink-50 ws-num">{((selected.stats?.words ?? 0) / 10000).toFixed(1)}</div>
                                <div className="mt-0.5 text-10 text-ink-500">万字</div>
                              </div>
                              <div className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-2.5 py-1.5 flex flex-col justify-center min-w-0">
                                <div className="text-[13px] leading-tight font-bold text-ink-100 truncate">{normalizeGenrePack(selected.genre)}</div>
                                <div className="mt-0.5 text-10 text-ink-500">作品题材</div>
                              </div>
                            </div>
                          </div>

                          {/* 2) 导出与备份 */}
                          <div className="rounded-xl border border-ink-700/75 bg-ink-850/90 p-3.5 ws-surface flex flex-col">
                            <h3 className="text-12 font-semibold text-ink-300 flex items-center gap-1.5 mb-2.5">
                              <FileUp size={13} className="text-amber" /> 导出与备份
                            </h3>
                            <div className="flex flex-col gap-1.5 flex-1 justify-center">
                              <Tooltip label="导出单本书完整 JSON 备份" className="w-full">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="w-full !justify-start"
                                  onClick={() => exportProject(selected)}
                                  title="导出 JSON 备份"
                                  aria-label="导出 JSON 备份"
                                >
                                  <FileUp size={13} className="text-amber shrink-0" /> 导出 JSON 备份
                                </Button>
                              </Tooltip>
                              <Tooltip label="汇总全部世界观 / 人物 / 设定表" className="w-full">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="w-full !justify-start"
                                  onClick={async () => {
                                    db.setCurrentProject(selected.id)
                                    const { exportSettingCompendium } = await import('@/lib/storage/exporter')
                                    void exportSettingCompendium(selected.name)
                                  }}
                                  title="导出设定集（汇总全部世界观 / 人物 / 设定表）"
                                  aria-label="导出设定集"
                                >
                                  <BookText size={13} className="text-amber shrink-0" /> 导出设定集
                                </Button>
                              </Tooltip>
                              <Tooltip label="查看 / 一键恢复历史自动备份" className="w-full">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="w-full !justify-start"
                                  onClick={() => { setBackupName(selected.name); setBackupPid(selected.id) }}
                                  title="备份与恢复：查看 / 一键恢复历史版本"
                                  aria-label="备份与恢复"
                                >
                                  <History size={13} className="text-amber shrink-0" /> 备份与恢复
                                </Button>
                              </Tooltip>
                            </div>
                          </div>

                          {/* 3) 危险操作 */}
                          <div className="rounded-xl border border-danger/25 bg-ink-850/90 p-3.5 ws-surface flex flex-col">
                            <h3 className="text-12 font-semibold text-danger flex items-center gap-1.5 mb-2">
                              <Trash2 size={13} /> 危险操作
                            </h3>
                            <p className="text-11 text-ink-400 leading-relaxed mb-3">
                              删除后《{selected.name}》的设定、大纲、正文与统计将一并移除且不可撤销，建议先导出 JSON 备份。
                            </p>
                            <Button
                              variant="danger"
                              size="sm"
                              className="mt-auto w-full"
                              onClick={() => removeProject(selected)}
                              title="删除项目"
                              aria-label="删除项目"
                            >
                              <Trash2 size={13} /> 删除项目
                            </Button>
                          </div>
                        </div>

                        {/* 4) 最近自动备份（占满右上整宽，双列展示 5 分钟定时与每日备份） */}
                        <div className="rounded-xl border border-ink-700/75 bg-ink-850/90 p-3.5 ws-surface flex-1 min-h-[164px] flex flex-col">
                          <div className="flex items-center justify-between gap-2 mb-2.5 shrink-0">
                            <h3 className="text-12 font-semibold text-ink-300 flex items-center gap-1.5">
                              <Shield size={13} className="text-amber" /> 最近自动备份
                            </h3>
                            <span className="text-11 text-ink-500 ws-num">
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
                  )
                })()}

                {/* ② 下半部分：最后编辑的章节（拉高填满剩余可视高度，仅内部框滚动） */}
                <section className="flex-1 min-h-[240px] flex flex-col rounded-xl border border-ink-700/75 bg-ink-850/90 p-4 ws-surface">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5 shrink-0">
                    <h3 className="text-12 font-semibold text-ink-300 flex items-center gap-1.5">
                      <FileText size={14} className="text-amber" /> 最后编辑的章节
                    </h3>
                    {selected.stats?.lastChapter && (
                      <div className="flex flex-wrap items-center gap-2 text-11 text-ink-500 ws-num">
                        {selected.stats.lastChapter.status && (
                          <span className="px-1.5 py-px rounded border border-ink-700 bg-ink-800/80 text-ink-300">
                            {selected.stats.lastChapter.status}
                          </span>
                        )}
                        <span>{selected.stats.lastChapter.wordCount} 字</span>
                        {selected.stats.lastChapter.updatedAt > 0 && (
                          <>
                            <span>·</span>
                            <span>更新于 {formatBackupTime(selected.stats.lastChapter.updatedAt)}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {!selected.stats?.lastChapter ? (
                    <p className="text-12 text-ink-500">这本书还没有创建章节，打开项目后即可开始创作。</p>
                  ) : (
                    <div className="flex-1 min-h-0 flex flex-col">
                      <div className="text-14 font-semibold text-ink-100 mb-2 truncate shrink-0">
                        {selected.stats.lastChapter.title}
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-ink-700/60 bg-ink-900/55 px-5 py-4 text-13 text-ink-200 leading-[1.85] whitespace-pre-wrap break-words">
                        {selected.stats.lastChapter.excerpt || '（本章暂未填写正文内容）'}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </main>
      </div>

      {backupPid && (
        <BackupManager
          projectId={backupPid}
          projectName={backupName}
          onClose={() => setBackupPid(null)}
          onRestored={() => { setBackupPid(null); showToast('已恢复到所选历史版本，重新打开项目即可看到') }}
          onImported={onOpen}
        />
      )}

      {editingId && (
        <Modal
          open
          onClose={closeEdit}
          title={`编辑项目${editingProject ? ` · ${editingProject.name}` : ''}`}
          icon={<Pencil size={15} className="text-amber" />}
          width="lg"
          accent="amber"
          footer={
            <>
              <Button variant="secondary" size="md" onClick={closeEdit}>
                取消
              </Button>
              <Button onClick={saveEdit} disabled={busy} variant="primary" solid size="md">
                <Check size={14} /> 保存修改
              </Button>
            </>
          }
        >
          <div className="flex flex-col sm:flex-row items-start gap-5">
            <div className="relative shrink-0" {...dropEditCover.dropProps}>
              <Button
                variant="bare"
                onClick={() => editCoverRef.current?.click()}
                className="group/cover relative w-[108px] h-[156px] rounded-lg border border-dashed border-ink-600 hover:border-amber/50 overflow-hidden transition-colors flex items-center justify-center shrink-0"
                title="上传封面（可选，2MB 以内；也可以把图片直接拖到这里）"
              >
                {editForm.cover ? (
                  <>
                    <SafeImage src={editForm.cover} alt="封面预览" retry={false} className="w-full h-full object-cover" />
                    <span
                      onClick={e => { e.stopPropagation(); setEditForm(f => ({ ...f, cover: '' })) }}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white/90 opacity-0 group-hover/cover:opacity-100 transition-opacity"
                      title="移除封面"
                    >
                      <X size={11} />
                    </span>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-1.5 text-ink-500 group-hover/cover:text-amber/70 transition-colors">
                    <ImageIcon size={18} />
                    <span className="text-10">上传封面</span>
                  </div>
                )}
              </Button>
              {dropEditCover.dragging && <DropOverlay compact radius="rounded-lg" label="松开上传" />}
            </div>
            <input
              ref={editCoverRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) pickEditCover(f); e.target.value = '' }}
            />
            <div className="min-w-0 flex-1 w-full">
              {/* 🔴 3.2.2（审计 U2）：看得见 ≠ 有名称 —— label 必须用 htmlFor 真正关联到输入框 */}
              <label htmlFor="edit-project-name" className="text-11 text-ink-400 mb-1 block">书名 *</label>
              <input
                id="edit-project-name"
                value={editForm.name}
                onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveEdit() }}
                autoFocus
                className="w-full text-13"
              />
              {/* 🔴 2.7.2：题材改到这里（页签里已没有切换入口，这里是老项目的唯一改法）。
                  只影响各页签里的字段说明与示例怎么写，不影响页签数量；填过的内容不会丢。 */}
              <label className="text-11 text-ink-400 mt-3 mb-1 block">作品题材</label>
              <GenrePackSelect
                value={editForm.genre}
                onChange={g => setEditForm(f => ({ ...f, genre: g }))}
                className="w-full"
              />
              {/* 3.0 · 社区反馈：题材此前会**无条件**混进 AI 上下文（「类型：都市异能」），
                  而它的定位只是「决定各页签字段名与示例」。现在默认不注入，想要就显式打开。 */}
              <label className="mt-3 inline-flex items-center gap-2 text-12 text-ink-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={editForm.genreToAI}
                  onChange={e => setEditForm(f => ({ ...f, genreToAI: e.target.checked }))}
                  className="m-0 h-3.5 w-3.5 shrink-0 accent-amber"
                />
                <span className="inline-flex items-center gap-1 leading-none">
                  <span>把作品题材告诉 AI</span>
                  <HelpPopover title="把作品题材告诉 AI" width="22rem" size={12}>
                    {'默认「不告诉」。\n\n'
                      + '· 关（默认）：题材只决定各页签里的字段名 / 说明 / 示例怎么写，'
                      + '不会出现在发给模型的资料里 —— AI 不会因为看到「类型：都市异能」就照题材套路发挥。\n'
                      + '· 开：发给模型的「作品概览」里会多一行「类型：都市异能」。'
                      + '适合希望 AI 明确知道赛道 / 题材常识的场合。\n\n'
                      + '📌 想要更具体的题材描述，推荐填《作品信息》页的「类型赛道」字段'
                      + '（例如「东方玄幻·升级流」）—— 那是你自己写的，会随设定资料照常发给 AI，'
                      + '比四字包名信息量大得多，也不受这个开关影响。'}
                  </HelpPopover>
                </span>
              </label>
            </div>
          </div>
          {editForm.projectType === 'custom' && (
            <div className="mt-4 pt-3.5 border-t border-ink-700/60">
              <div className="text-11 text-ink-400 mb-1.5 flex items-center gap-1">功能模块
                <HelpPopover title="自定义项目功能" width="20rem" size={11}>
                  {'勾选 / 取消勾选要启用的功能模块。必选模块（工作面板里的写作面板 / 模型设置 / 使用指南 / 关于打赏，正文写作，灵感工具下的灵感启发 / 素材资料 / 检查工具）与依赖自动带入的模块不可取消；其余模块（含拆书、创意写作）自由调整。修改后点击「保存修改」生效。'}
                </HelpPopover>
              </div>
              <Button variant="secondary" type="button" onClick={() => setFeatureModal({ mode: 'edit', initial: editForm.features.filter(id => !LOCKED_IDS.includes(id)) })} className="flex items-center gap-1.5 rounded-lg transition-colors">
                <ListChecks size={13} /> 已启用 {editForm.features.length} 个功能 · 编辑功能
              </Button>
            </div>
          )}
        </Modal>
      )}

      {featureModal && (
        <FeatureSelectModal
          title={featureModal.mode === 'create' ? '选择自定义项目功能' : '编辑项目功能'}
          initialSelected={featureModal.initial}
          onConfirm={features => {
            if (featureModal.mode === 'create') setForm(f => ({ ...f, features }))
            else setEditForm(f => ({ ...f, features }))
            setFeatureModal(null)
          }}
          onClose={() => setFeatureModal(null)}
        />
      )}

      {appIconOpen && <AppIconDialog onClose={() => setAppIconOpen(false)} />}
      {helpOpen && (
        <Modal open onClose={() => setHelpOpen(false)} title="使用答疑助手" width="2xl" maxHeight="86vh" className="help-modal">
          {/* projectOpen={false}：这里没有打开项目，所有「前往功能」禁用并说明要先开项目 */}
          <HelpCenter
            onNavigate={() => showToast('先打开一个项目，才能跳到这个功能页', 'info')}
            ctx={{ type: 'full', features: [] }}
            projectOpen={false}
            receiveArticleRequests={false}
          />
        </Modal>
      )}
    </div>
  )
}
