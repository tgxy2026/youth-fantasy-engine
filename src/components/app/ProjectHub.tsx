import { useEffect, useState, useCallback, useRef } from 'react'
import * as db from '@/lib/db'
import type { ProjectBundle } from '@/lib/db'
import type { Project } from '@/lib/types'
import { createDemoProject } from '@/lib/app/seedData'
import {
  Sparkles, BookPlus, FolderOpen, Trash2, Upload, FileDown, X, Feather, Loader2, ImageIcon, Pencil, Check, BookText, History, ListChecks, Eye, EyeOff, Compass,
} from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import HelpCenter from '@/components/help/HelpCenter'
import { Modal } from '@/components/dialogs/Modal'
import SafeImage from '@/components/common/SafeImage'
import Tooltip from '@/components/common/Tooltip'
import { Z } from '@/lib/app/zLayer'
import { foldVh } from '@/lib/settings/theme'
import BackupManager from '@/components/app/BackupManager'
import FeatureSelectModal from '@/components/dialogs/FeatureSelectModal'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import BrandMark from '@/components/common/BrandMark'
import { downloadBlob } from '@/lib/storage/zip'
import { markExported } from '@/lib/sync/backupReminder'
import { rebuildKbIndexAfterRestore } from '@/lib/search/kbRestoreIndex'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { usePersistedBool, readBoolPref, readStringPref } from '@/lib/settings/uiPrefs'
import { LOCKED_IDS, DEFAULT_IDS } from '@/lib/schema'
import { DEFAULT_PACK, normalizeGenrePack, setActivePack, type GenrePack } from '@/lib/schemaTemplates/index'
import { getGenreToAIFor, setGenreToAIFor } from '@/lib/ai/aiGenreHint'
import { GenrePackSelect } from '@/components/creative/GenrePackSelect'
import workbenchBg from '@/assets/workbench-bg.png'
// 看板娘立绘改用 WebP（2026-10-18 · 网页版首屏优化）：
// 原 PNG 1440×2560 / 4.18 MB，而界面最大只显示 380 CSS px 宽（2x 屏需 760px），冗余 3.4 倍。
// 已转为 768×1365 WebP（q82 + lossless alpha）/ 249 KB —— **省 94.2%**，视觉无差异。
// 🔴 原 `jiewenji-gufeng.png` 保留在 assets 里作素材源，但**不再被 import**（不参与打包）。
//    要换回 PNG 只需把这行改回去，别删源文件。
import jiewenjiGufeng from '@/assets/jiewenji-gufeng.webp'
import { Button } from '@/components/common/Button'
import { useImageDrop, DropOverlay } from '@/components/common/ImageDropZone'
import MascotSettingsDialog from '@/components/settings/MascotSettingsDialog'
import AppIconDialog from '@/components/settings/AppIconDialog'
import { appIconSupported } from '@/lib/app/desktop'

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
  stats?: { chapters: number; words: number; volumes: number }
}

type CreateType = 'full' | 'custom'

export default function ProjectHub({ onOpen, onReplayWelcome }: Props) {
  const [projects, setProjects] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<{ name: string; cover: string; projectType: CreateType; features: string[]; genre: GenrePack }>({ name: '', cover: '', projectType: 'full', features: [], genre: DEFAULT_PACK })
  const [busy, setBusy] = useState(false)
  /** 3.3.1 · P4：未打开项目也能读手册（规划 §4.3「项目管理页也提供手册入口」） */
  const [helpOpen, setHelpOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
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
  // #002 看板娘显示开关：默认「显示」，故按 uiPrefs 的约定存「偏离默认的那一侧」＝存「已隐藏」。
  // 走 yfe-ui: 命名空间 → 只服务「这台机器上这个人的界面习惯」，不进项目数据、不随导出/同步走。
  // 🔴 2.6.1 · R1：hidden 不能用 usePersistedBool（hook 内部 state 不跨组件同步——弹窗里切了开关
  //    首页的立绘不会动）。改自持 state + 弹窗 onSaved 时统一重读 localStorage。
  const [mascotHidden, setMascotHiddenState] = useState(() => readBoolPref('home-mascot-hidden', false))
  // 2.6.1 · R1：看板娘设置弹窗 + 自定义图（uiPrefs `yfe-ui:home-mascot-custom`，本机偏好不进云同步）
  const [mascotSettingOpen, setMascotSettingOpen] = useState(false)
  const [mascotCustom, setMascotCustom] = useState<string | null>(() => readStringPref('home-mascot-custom'))
  const reloadMascotPrefs = () => {
    setMascotHiddenState(readBoolPref('home-mascot-hidden', false))
    setMascotCustom(readStringPref('home-mascot-custom'))
  }
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
    const withStats = list.map(p => ({ ...p, stats: statsMap[p.id] }))
    setProjects(withStats)
    setLoaded(true)
  }, [])

  useEffect(() => { load() }, [load])

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

  return (
    <div data-project-hub className="min-h-screen bg-transparent overflow-y-auto relative">
      {/* 与项目内页一致：金色线稿背景，透明底、置于最底层从半透明面板后透出（2.6.1 起受侧栏「背景」开关控制） */}
      {!bgHidden && (
      <div
        className="absolute inset-0 pointer-events-none bg-cover bg-center bg-no-repeat opacity-100"
        style={{ backgroundImage: `url(${workbenchBg})`, zIndex: Z.pageBackdrop }}
        aria-hidden
      />
      )}
      {/* 右侧预留 gutter（sm+）：为右下角看板娘腾出空间，保证卡片不进入该区域，互不遮挡 */}
      {/*
        底部留白 = 左下角数据坞的实测高度（`--dock-height`，由 DataDock 按布局单位发布）。
        🔴 3.3.1 · P5：手动 130% 缩放时那块浮层会把最后一行卡片的「打开项目」按钮压在下面，
           鼠标点不到（探针实测 272×346）。留出空间让作者能把它滚上来 —— 不是把工具栏藏起来。
        上限 340px：窗口很矮时不至于多出一大片空白。
      */}
      <div
        className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 pt-10 page-enter"
        style={{ zIndex: Z.pageHandle, paddingBottom: 'min(calc(var(--dock-height, 0px) + 2.5rem), 340px)' }}
      >
        {/* 品牌区 */}
        <header className="mb-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber/15 border border-amber/30 mb-4">
            <BrandMark size={26} className="text-amber" />
          </div>
          <h1 className="text-2xl font-bold text-ink-50 tracking-wide flex items-baseline justify-center gap-2">
            青春幻想引擎
            <span className="text-base font-normal text-ink-400">{APP_VERSION_LABEL}</span>
          </h1>
          <p className="mt-2 text-13 text-ink-400">在你的世界中讲述你的故事</p>
        </header>

        {/* 操作条 */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-14 font-semibold text-ink-100 flex items-center gap-2 flex-wrap">
            <Sparkles size={14} className="text-amber" /> 我的作品 ({projects.length})
            <span className="text-12 font-normal text-ink-400">每本书是一个独立项目 · 打开后进入完整创作面板</span>
            <HelpPopover title="项目管理怎么用" width="22rem" size={13}>
              {'一本书 = 一个独立项目，设定 / 大纲 / 正文 / 统计互不干扰。\n\n· 新建小说项目：只需书名即可开工，封面与其他信息随时可补；\n· 创建示范项目：一键写入完整范例数据（卷章正文、设定表单、角色卡、伏笔、时间脉络、码字统计），用来快速摸清各功能怎么用，体验完可直接删除；\n· 导入已有项目：选择之前导出的 .json 备份即可还原全部内容；\n· 备份：把某本书导出成 .json 文件，换设备或重装前务必先导一份；导入已有项目可选择之前的 .json 备份还原；\n· 设定集：一键导出汇总全书世界观 / 人物 / 设定表的 Markdown 文档；\n· 备份与恢复：查看打开项目时自动生成的备份（每 5 分钟 / 每日首次打开各一类），可一键恢复历史版本；\n· 打开项目：进入该书的完整创作面板。'}
            </HelpPopover>
          </h2>
          <div className="flex gap-2 items-stretch shrink-0">
            <Button onClick={createDemo}
              disabled={busy}
              
              title="一键创建含完整示例数据的测试项目" variant="secondary" size="md" className="flex items-center">
              <BookPlus size={13} /> 创建示范项目
            </Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()} className="transition-colors">
              <FileDown size={13} /> 导入已有项目
            </Button>
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
            <Button variant="primary" onClick={() => setCreating(true)} className="flex items-center gap-1.5 font-medium transition-colors">
              <BookPlus size={14} /> 新建小说项目
            </Button>
            {/* 2.6.1 · R1：按钮升级为「看板娘设置」——开关与自定义图都进弹窗（原直接 toggle 行为收进弹窗内开关） */}
            <Button
              variant="toggle"
              selected={!mascotHidden}
              onClick={() => setMascotSettingOpen(true)}
              title="看板娘设置：显示 / 隐藏、更换自定义图片"
              className="flex items-center gap-1.5 px-3.5 h-9 text-13 rounded-lg"
            >
              {mascotHidden ? <EyeOff size={13} /> : <Eye size={13} />} 看板娘设置
            </Button>
            {/* 3.1.2：桌面图标（快捷方式）切换 —— 看板娘设置旁边，同档 secondary、同 size，
                仅桌面安装版显示；三套内置预设（默认 / 幻想 / 典雅）在弹窗里选。 */}
            {appIconOk && (
              <Button
                variant="secondary"
                onClick={() => setAppIconOpen(true)}
                title="应用图标：切换桌面快捷方式的图标（桌面 / 开始菜单同时生效）"
                className="transition-colors"
              >
                <ImageIcon size={13} /> 应用图标
              </Button>
            )}
            {onReplayWelcome && (
              <Button variant="secondary" onClick={onReplayWelcome}
                title="重新看一遍新手引导（三选一 + 顺手指引）—— 不会改动任何已有数据"
                className="transition-colors">
                <Compass size={13} /> 新手引导
              </Button>
            )}
            {/* 🔴 使用手册紧跟「新手引导」：两者都是「不认识这个软件时从哪开始」的入口，
                放在一起才找得到；此前它挤在「我的作品」操作条里，和新建/导入那些动手按钮混在一处。 */}
            <Button variant="secondary" onClick={() => setHelpOpen(true)}
              title="不用打开项目也能查使用手册、问功能用法"
              className="transition-colors">
              <Compass size={13} /> 使用手册
            </Button>
          </div>
        </div>

        {/* 新建表单 */}
        {creating && (
          <div className="mb-6 rounded-xl border border-amber/25 bg-ink-850 p-5 page-enter">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-13 font-semibold text-ink-100">新建小说项目</h3>
              <Button variant="icon-muted" onClick={() => setCreating(false)} title="关闭" aria-label="关闭"><X size={16} /></Button>
            </div>
            <div className="flex gap-5">
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
              <div className="flex-1 flex flex-col gap-3">
                {/* 项目形态：完整 / 自定义 */}
                <div>
                  <label className="text-11 text-ink-400 mb-1 block flex items-center gap-1">项目形态
                    <HelpPopover title="项目形态怎么选" width="23rem" size={11}>
                      {'决定项目初始开放哪些功能，新建时选定、创建后不可更改：\n\n· 完整项目：功能最全，适合中长篇连载——含全部设定表（力量体系、人物关系、国家 / 地理 / 种族 / 物品设定、历史事件、伏笔、时间脉络、知情权限、分卷大纲、设定变更等）与灵感 / 检查工具；\n· 自定义项目：从完整项目功能全集里自由勾选要启用的模块（工作面板、正文写作、灵感工具里的「灵感启发 / 素材资料 / 检查工具」，以及运营维护里的「关于打赏」为必选、不可取消，拆书与创意写作默认不勾选、需要时单独勾上；备份与恢复 / 全文检索 / 设定检索为全局基础设施、始终常开（不进入清单、不可取消）；其余模块自由勾选）。拿不准就选「完整项目」，用不到的模块不填即可。'}
                    </HelpPopover>
                  </label>
                  <div className="flex gap-2">
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
                      {'它只决定一件事：《开书定位》各页签里的「字段名、填写说明与示例」随哪一套走。\n\n'
                        + '· 选「历史古代」，「政治架构」里的示例会是「九品十八级、府兵制、刑部大理寺」；\n'
                        + '· 选「科幻末世」，同一批字段的示例会变成「联交所、行星防卫军、生态舱配给」。\n\n'
                        + '📌 它「不影响页签数量」 —— 完整项目的《开书定位》六个页签全部显示；'
                        + '自定义项目则按你在「功能模块」里勾的来。\n'
                        + '📌 选错了不要紧：回项目管理页「编辑项目」能改，填过的内容不会丢（换题材只换示例，不动字段名）。\n\n'
                        + '🔴 它「默认不会告诉 AI」 —— 题材不进模型看到的资料，AI 不会因为看到「类型：都市异能」'
                        + '就照题材套路发挥。想让它知道：回「编辑项目」打开「把作品题材告诉 AI」，'
                        + '或直接填《作品信息》页的「类型赛道」字段（那一路一直会发给 AI，且是你自己写的描述）。'}
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
                <Button onClick={create}
                  disabled={busy} variant="primary" solid size="md" className="w-full">
                  {busy ? '创建中…' : '创建并进入项目'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 项目卡片 */}
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-700 py-16 text-center">
            <BookPlus size={28} className="mx-auto text-ink-600 mb-3" />
            <div className="text-13 text-ink-400">还没有作品，点击右上角「新建小说项目」开启第一本书</div>
            <div className="mt-1.5 text-11 text-ink-500">
              第一次使用？点上方「创建示范项目」，一键体验全部功能
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {([
              { key: 'full', label: '完整项目' },
              { key: 'custom', label: '自定义项目' },
            ] as const).map(g => {
              const items = projects.filter(p => (p.projectType ?? 'full') === g.key)
              if (items.length === 0) return null
              return (
                <section key={g.key}>
                  <h3 className="text-13 font-semibold text-ink-200 flex items-center gap-2 mb-3">
                    {g.label}
                    <span className="px-1.5 py-px text-10 rounded bg-ink-800 text-ink-400 border border-ink-700">{items.length}</span>
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                    {items.map(p => (
              <div key={p.id} data-project-card={p.id} className="group bg-ink-850 border border-ink-700 rounded-xl p-5 hover:border-amber/30 transition-all card-hover">
                {editingId === p.id ? (
                  /* 编辑模式：修改书名与封面 */
                  <div>
                    <div className="flex items-start gap-4">
                      <div className="relative shrink-0" {...dropEditCover.dropProps}>
                        <Button variant="bare"
                          onClick={() => editCoverRef.current?.click()}
                          className="group/cover relative w-[92px] h-[128px] rounded-md border border-dashed border-ink-600 hover:border-amber/50 overflow-hidden transition-colors flex items-center justify-center shrink-0"
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
                              <ImageIcon size={16} />
                              <span className="text-10">上传封面</span>
                            </div>
                          )}
                        </Button>
                        {dropEditCover.dragging && <DropOverlay compact radius="rounded-md" label="松开上传" />}
                      </div>
                      <input
                        ref={editCoverRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) pickEditCover(f); e.target.value = '' }}
                      />
                      <div className="min-w-0 flex-1">
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
                        <label className="text-11 text-ink-400 mt-2 mb-1 block">作品题材</label>
                        <GenrePackSelect
                          value={editForm.genre}
                          onChange={g => setEditForm(f => ({ ...f, genre: g }))}
                          className="w-full"
                        />
                        {/* 3.0 · 社区反馈：题材此前会**无条件**混进 AI 上下文（「类型：都市异能」），
                            而它的定位只是「决定各页签字段名与示例」。现在默认不注入，想要就显式打开。 */}
                        <label className="mt-1.5 flex items-start gap-1.5 text-11 text-ink-400 cursor-pointer select-none">
                          <input type="checkbox" checked={editForm.genreToAI}
                            onChange={e => setEditForm(f => ({ ...f, genreToAI: e.target.checked }))}
                            className="mt-px accent-amber" />
                          <span>把作品题材告诉 AI
                            <HelpPopover title="把作品题材告诉 AI" width="22rem" size={11}>
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
                      <div className="mt-4">
                        <div className="text-11 text-ink-400 mb-1.5 flex items-center gap-1">功能模块
                          <HelpPopover title="自定义项目功能" width="20rem" size={11}>
                            {'勾选 / 取消勾选要启用的功能模块。必选模块（工作面板、正文写作，灵感工具下的灵感启发 / 素材资料 / 检查工具，以及运营维护下的关于打赏）与依赖自动带入的模块不可取消；其余模块（含拆书、创意写作）自由调整。修改后点击「保存修改」生效。'}
                          </HelpPopover>
                        </div>
                        <Button variant="secondary" type="button" onClick={() => setFeatureModal({ mode: 'edit', initial: editForm.features.filter(id => !LOCKED_IDS.includes(id)) })} className="flex items-center gap-1.5 rounded-lg transition-colors">
                          <ListChecks size={13} /> 已启用 {editForm.features.length} 个功能 · 编辑功能
                        </Button>
                      </div>
                    )}
                    <div className="mt-4 flex items-center gap-2">
                      <Button onClick={saveEdit}
                        disabled={busy} variant="primary" size="md" className="flex items-center">
                        <Check size={13} /> 保存修改
                      </Button>
                      <Button variant="secondary" onClick={() => { editPidRef.current = null; setEditingId(null) }} className="border-ink-600 hover:border-ink-500 transition-colors">
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-stretch gap-5 min-h-[184px]">
                      {p.cover ? (
                        <SafeImage src={p.cover} alt={p.name} retry={false} className="w-128px object-cover rounded-md border border-ink-600 shrink-0 self-stretch" />
                      ) : (
                        <div className="w-128px rounded-md border border-dashed border-ink-600 bg-ink-800/60 shrink-0 self-stretch flex items-center justify-center">
                          <Feather size={22} className="text-ink-600" />
                        </div>
                      )}
                      <div className="flex-1 min-w-[min(100%,12rem)] flex flex-col">
                        <div>
                          <h3 className="text-15 font-bold text-ink-50 truncate">{p.name}</h3>
                          {/* 这一行**只留卷 / 章 / 字数**（2026-09-19 老大要求）：
                              题材标签多数和书名重复，形态标签（自定义）在编辑项目里能看到 ——
                              列表上多两个彩色胶囊，扫一眼只添噪声。 */}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-10 text-ink-500">
                              {p.stats?.volumes ?? 0} 卷 · {p.stats?.chapters ?? 0} 章 · {((p.stats?.words ?? 0) / 10000).toFixed(1)} 万字
                            </span>
                          </div>
                          {p.intro && <p className="mt-2 text-11 text-ink-400 line-clamp-2">{p.intro}</p>}
                          <div className="mt-2 text-10 text-ink-600">
                            创建于 {new Date(p.createdAt).toLocaleDateString()} · 最近活动 {new Date(p.updatedAt).toLocaleDateString()}
                          </div>
                        </div>
                        <div data-project-actions className="mt-auto pt-3 grid w-full max-w-[236px] grid-cols-6 items-center gap-1.5 [&>span]:min-w-0 [&>span>button]:!w-full [&>span>button]:!min-w-0">
                          <Tooltip label="打开项目">
                            <Button variant="primary" iconOnly size="sm"
                              onClick={() => onOpen(p.id)}
                              title="打开项目"
                              aria-label="打开项目"
                            >
                              <FolderOpen size={17} />
                            </Button>
                          </Tooltip>
                          <Tooltip label="导出 JSON 备份">
                            <Button variant="icon-ghost" iconOnly size="sm"
                              onClick={() => exportProject(p)}
                              title="导出 JSON 备份"
                              aria-label="导出 JSON 备份"
                            >
                              <Upload size={16} />
                            </Button>
                          </Tooltip>
                          <Tooltip label="导出设定集">
                            <Button variant="icon-ghost" iconOnly size="sm"
                              onClick={async () => { db.setCurrentProject(p.id); const { exportSettingCompendium } = await import('@/lib/storage/exporter'); void exportSettingCompendium(p.name) }}
                              title="导出设定集（汇总全部世界观 / 人物 / 设定表）"
                              aria-label="导出设定集"
                            >
                              <BookText size={16} />
                            </Button>
                          </Tooltip>
                          <Tooltip label="备份与恢复">
                            <Button variant="icon-ghost" iconOnly size="sm"
                              onClick={() => { setBackupName(p.name); setBackupPid(p.id) }}
                              title="备份与恢复：查看 / 一键恢复历史版本"
                              aria-label="备份与恢复"
                            >
                              <History size={16} />
                            </Button>
                          </Tooltip>
                          <Tooltip label="编辑项目">
                            <Button variant="icon-ghost" iconOnly size="sm"
                              onClick={() => startEdit(p)}
                              title="编辑项目"
                              aria-label="编辑项目"
                            >
                              <Pencil size={16} />
                            </Button>
                          </Tooltip>
                          <Tooltip label="删除项目" side="bottom">
                            <Button variant="icon-danger" iconOnly size="sm"
                              onClick={() => removeProject(p)}
                              className="hover:bg-danger/10"
                              title="删除项目"
                              aria-label="删除项目"
                            >
                              <Trash2 size={17} />
                            </Button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {backupPid && (
          <BackupManager
            projectId={backupPid}
            projectName={backupName}
            onClose={() => setBackupPid(null)}
            onRestored={() => { setBackupPid(null); showToast('已恢复到所选历史版本，重新打开项目即可看到。') }}
            onImported={onOpen}
          />
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
      </div>
      {/* 古风看板娘 · 项目管理页右下角静态立绘（v1.9.1）—— 透明底 PNG，无动画；pointer-events-none 不挡交互；
          右下角 fixed，配合内容容器右侧留白，保证不遮挡项目列示区域、也不被其遮挡；手机端隐藏以免拥挤。
          #036 宽度改「视口比例 + 上限」：原来 w-[160/240/320/380px] 是绝对值，而断点只看**逻辑像素宽度**、
          不看物理尺寸 —— 1280 逻辑宽的小屏（14 寸 2K@200%）与 2560 的大屏（32 寸 4K@150%）同命中 xl，
          380px 占比从 19.6% 翻到 29.7%、纵向吃掉 82% 屏高，实测压住右上角「创建/新建项目」按钮。
          min(380px, 20vw) 经 foldVh 折算（vw 在 zoom 下不缩，必须折）后视觉占比恒为 20%；
          大屏仍走 380px 上限 → 观感与改动前完全一致。 */}
      {/* #002 看板娘显示开关：默认显示；设置弹窗可切（偏好走 yfe-ui:）。2.6.1 · R1 起支持自定义图（本机偏好优先于内置） */}
      {!mascotHidden && (
      <img
        src={mascotCustom || jiewenjiGufeng}
        alt="古风看板娘"
        draggable={false}
        className="fixed bottom-4 right-4 hidden sm:block h-auto pointer-events-none select-none drop-shadow-2xl"
        style={{ zIndex: Z.sprite, width: foldVh('min(380px, 20vw)'), maxHeight: foldVh('82vh') }} // vw/vh 都要折算，否则缩放 ≠100% 时占比失真
      />
      )}
      {mascotSettingOpen && (
        <MascotSettingsDialog
          onClose={() => setMascotSettingOpen(false)}
          onSaved={reloadMascotPrefs}
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
