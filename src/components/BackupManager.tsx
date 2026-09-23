import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as db from '../lib/db'
import { encryptJSON, decryptJSON, isEncrypted } from '../lib/crypto'
import { Trash2, RotateCcw, Clock, CalendarDays, ShieldCheck, Upload, FileDown, Lock, AlertTriangle, ChevronDown } from 'lucide-react'
import PromptModal from './PromptModal'
import { confirmDialog, showToast } from './dialogs'
import { downloadBlob } from '../lib/zip'
import { markExported } from '../lib/backupReminder'
import HelpPopover from './HelpPopover'
import { Modal } from './Modal'
import { Button } from './Button'

interface Props {
  projectId: string
  projectName: string
  onClose: () => void
  onRestored: () => void
  /** 导入迁移包成功后，用新项目 id 打开它（由 ProjectHub 的 onOpen 承接） */
  onImported?: (projectId: string) => void
}

/**
 * 备份与恢复（v1.3 备份策略加固；#012 备份体积治理）
 * - 列出该项目的全部备份：手动 / 每日自动 / 5 分钟自动。
 * - 一键恢复历史版本（覆盖回写，保留项目 id）。
 * - 5 分钟自动滚动保留最多 30 份；每日自动保留最多 30 份；**手动备份不设上限**
 *   （用户主动留档不该被系统删掉），份数过多时给出体验提示。
 */
export default function BackupManager({ projectId, projectName, onClose, onRestored, onImported }: Props) {
  const [backups, setBackups] = useState<db.BackupRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // 恢复 / 导入成功后都要重新拉列表，故用 useCallback 钉住引用供 effect 依赖
  const load = useCallback(async () => {
    const list = await db.listBackups(projectId)
    setBackups(list)
    setLoaded(true)
  }, [projectId])
  useEffect(() => { void load() }, [load])

  // v1.6.1：孤儿备份（项目已删除但备份按约定保留）统计与清理
  const [orphans, setOrphans] = useState<db.BackupRecord[]>([])
  useEffect(() => {
    void db.listOrphanBackups().then(setOrphans).catch(() => {})
  }, [])
  const orphansMB = useMemo(() => orphans.reduce((s, b) => s + b.bytes, 0) / 1024 / 1024, [orphans])
  const cleanOrphans = async () => {
    if (busy || orphans.length === 0) return
    if (!await confirmDialog({
      title: '清理孤儿备份',
      message: `将删除 ${orphans.length} 份「项目已删除」的备份（约 ${orphansMB.toFixed(1)} MB）。\n\n这些备份对应的项目已不存在，删除后不可恢复。确定清理？`,
      confirmText: '清理',
      danger: true,
    })) return
    setBusy(true)
    try {
      const n = await db.deleteOrphanBackups()
      setOrphans(await db.listOrphanBackups())
      showToast(`已清理 ${n} 份孤儿备份`, 'success')
    } catch (e) {
      showToast('清理失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  const restore = async (b: db.BackupRecord) => {
    if (busy) return
    if (!await confirmDialog({
      title: '恢复历史版本',
      message: `确定将「${projectName}」恢复到该备份版本？\n时间：${new Date(b.createdAt).toLocaleString()}\n\n恢复会用备份内容覆盖当前全部数据（卷/章/设定表/角色卡），覆盖后不可撤销，建议先手动备份当前版本。`,
      confirmText: '恢复', danger: true,
    })) return
    setBusy(true)
    try {
      await db.restoreBackup(b.id)
      onRestored()
    } catch (e) {
      showToast('恢复失败：' + (e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!await confirmDialog({ title: '删除备份', message: '确定删除这份备份？', danger: true })) return
    await db.deleteBackup(id)
    load()
  }

  const backupNow = async () => {
    if (busy) return
    setBusy(true)
    try {
      // #012：手动备份用独立类型，不参与自动滚动淘汰（用户主动留档不该被系统删掉）
      await db.createAutoBackup(projectId, 'manual', `手动备份 ${new Date().toLocaleString()}`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  /**
   * C2：把某一份备份导出成**磁盘上的独立文件**。
   * 自动备份只活在软件自己的数据文件里（本机、单点），导成文件才能丢进云盘 / 移动硬盘。
   */
  const exportFile = async (b: db.BackupMeta) => {
    if (busy) return
    setBusy(true)
    try {
      const f = await db.buildBackupFile(b.id)
      if (!f) { showToast('这份备份的数据已缺失，无法导出', 'error'); return }
      downloadBlob(f.filename, new Blob([f.content], { type: 'application/json' }))
      markExported()
      showToast(`已导出 ${f.filename}`)
    } catch (e) {
      showToast('导出备份文件失败：' + (e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ============ v1.3 迁移 / 换机：导出加密或明文迁移包，导入到另一台设备 ============
  // v1.6：密码输入改走应用内 PromptModal（浏览器 prompt 在 Electron 桌面端无实现）
  const [pwdPrompt, setPwdPrompt] = useState<null | { kind: 'export' | 'import'; exportBundle?: db.ProjectBundle; importText?: string }>(null)

  const exportMigration = async () => {
    if (busy) return
    setBusy(true)
    try {
      const bundle = await db.exportProject(projectId)
      setPwdPrompt({ kind: 'export', exportBundle: bundle })
    } catch (e) {
      showToast('导出迁移包失败：' + (e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const submitExportPwd = async (pwd: string) => {
    const p = pwdPrompt
    setPwdPrompt(null)
    if (!p?.exportBundle) return
    setBusy(true)
    try {
      let content: string
      let tag = ''
      if (pwd.length > 0) {
        content = await encryptJSON(p.exportBundle, pwd)
        tag = '-加密'
      } else {
        content = JSON.stringify(p.exportBundle, null, 2)
      }
      downloadBlob(
        `青春幻想引擎-迁移包-${projectName}-${new Date().toISOString().slice(0, 10)}${tag}.json`,
        new Blob([content], { type: 'application/json' }),
      )
      markExported() // #031：迁移包也是导出到外部文件，同样算一次备份
    } catch (e) {
      showToast('导出迁移包失败：' + (e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const finishImport = async (bundle: db.ProjectBundle) => {
    try {
      const newPid = await db.importProject(bundle)
      showToast('导入成功！即将打开该项目。')
      onImported?.(newPid)
      onClose()
    } catch (err) {
      showToast('导入失败：' + (err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const submitImportPwd = async (pwd: string) => {
    const p = pwdPrompt
    setPwdPrompt(null)
    if (!p?.importText) return
    setBusy(true)
    try {
      const bundle = await decryptJSON<db.ProjectBundle>(p.importText, pwd)
      await finishImport(bundle)
    } catch (err) {
      showToast('导入失败：' + (err as Error).message, 'error')
      setBusy(false)
    }
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (busy) return
    setBusy(true)
    try {
      const text = await file.text()
      if (isEncrypted(text)) {
        // 加密包：先要密码（busy 先复位；取消弹窗即放弃导入）
        setBusy(false)
        setPwdPrompt({ kind: 'import', importText: text })
        return
      }
      await finishImport(JSON.parse(text) as db.ProjectBundle)
    } catch (err) {
      showToast('导入失败：' + (err as Error).message, 'error')
      setBusy(false)
    }
  }

  /**
   * C2：从**外置备份文件**恢复**当前项目**。
   * 与「导入迁移包」的区别：迁移包是「换机搬运 → 新建一个项目」，这里是把备份覆盖回本项目。
   */
  const backupFileInput = useRef<HTMLInputElement>(null)
  const onBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || busy) return
    setBusy(true)
    try {
      const parsed = db.parseBackupFile(await file.text())
      const when = new Date(parsed.meta.createdAt).toLocaleString()
      if (!await confirmDialog({
        title: '从备份文件恢复',
        message: `将用文件里的备份（${parsed.meta.label} · ${when}）覆盖当前项目「${projectName}」的全部数据。\n\n`
          + '覆盖后不可撤销，建议先「立即备份」一份当前版本。确定恢复？',
        confirmText: '恢复', danger: true,
      })) { setBusy(false); return }
      await db.restoreBundleToProject(projectId, parsed.bundle)
      onRestored()
    } catch (err) {
      showToast('恢复失败：' + (err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const daily = backups.filter(b => b.kind === 'daily')
  const auto = backups.filter(b => b.kind === 'auto5min')
  const manual = backups.filter(b => b.kind === 'manual')

  // C2：体积直接读元数据里的 bytes（写入备份时算好并存下来）——
  //     不再对每份备份做一次 JSON.stringify 算体积（那是列表页最重的一步）。
  const sizeOf = (b: db.BackupMeta) => {
    const kb = (b.bytes ?? 0) / 1024
    return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`
  }
  // #012：份数过多会让数据文件变大、开关与保存变慢
  const totalMB = backups.reduce((s, b) => s + (b.bytes ?? 0), 0) / 1024 / 1024
  // 折叠状态（只对 collapsible 的分组有意义；默认全收起 = 两组自动备份默认折叠）
  const [openGroup, setOpenGroup] = useState<Record<string, boolean>>({})
  const MANY_BACKUPS = 40
  const tooMany = backups.length > MANY_BACKUPS

  /**
   * 分组列表 —— `collapsible` 的两组（每日 / 5 分钟自动）**默认收起**（老大 2026-09-15）：
   * 自动备份会随着使用一直涨，展开着会把弹窗撑得很长。
   * 收起时头部照旧显示「份数 · 上限」，信息不丢；手动备份保持展开 —— 那通常才是要找来恢复的那一批。
   */
  const Group = ({ id, title, icon, items, hint, collapsible = false }: {
    id: string; title: string; icon: ReactNode; items: db.BackupRecord[]; hint: string; collapsible?: boolean
  }) => {
    const expanded = !collapsible || !!openGroup[id]
    // 头部：只有**能折**的分组才是按钮（不可折的渲染成普通 div —— 别做点了没反应的假按钮）
    const head = (
      <>
        {icon}
        <span className="text-13 font-semibold text-ink-100">{title}</span>
        <span className="text-11 text-ink-500">{items.length} 份 · {hint}</span>
        {collapsible && (
          <ChevronDown size={13} className={`ml-auto text-ink-500 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
        )}
      </>
    )
    return (
    <div className="rounded-lg border border-ink-700 bg-ink-850/40">
      {collapsible ? (
        <Button variant="bare"
          onClick={() => setOpenGroup(m => ({ ...m, [id]: !m[id] }))}
          className="w-full flex items-center gap-2 px-3 py-2"
          title={expanded ? '收起这一组' : '展开这一组'}
        >
          {head}
        </Button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{head}</div>
      )}
      {expanded && <div className="px-3 pb-3">
      {items.length === 0 ? (
        <div className="text-11 text-ink-600 px-1 py-2">暂无备份</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(b => (
            <div key={b.id} className="flex items-center gap-3 bg-ink-850 border border-ink-700 rounded-lg px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-12 text-ink-100">{b.label}</div>
                <div className="text-10 text-ink-500">{new Date(b.createdAt).toLocaleString()} · {sizeOf(b)}</div>
              </div>
              <Button variant="bare"
                onClick={() => restore(b)}
                disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1.5 text-11 text-emerald-400 border border-emerald-500/30 rounded-md hover:bg-emerald-500/10 disabled:opacity-50"
                title="用此版本覆盖当前项目"
              >
                <RotateCcw size={11} /> 恢复
              </Button>
              {/* C2：把这一份导成磁盘文件 —— 自动备份只在本机数据文件里，导出来才有一份独立退路 */}
              <Button variant="icon-muted"
                onClick={() => void exportFile(b)}
                disabled={busy}
                className="p-1.5"
                title="把这份备份导出成文件（可放进云盘 / 移动硬盘）"
              >
                <Upload size={12} />
              </Button>
              <Button variant="icon-danger" onClick={() => remove(b.id)} disabled={busy} className="p-1.5" title="删除备份">
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}
      </div>}
    </div>
  )
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`备份与恢复 · ${projectName}`}
        icon={<ShieldCheck size={16} />}
        width={672}
        headerExtra={
          <Button variant="bare"
            onClick={backupNow}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1.5 text-11 text-amber border border-amber/30 rounded-lg hover:bg-amber/10 disabled:opacity-50"
            title="立即生成一份手动备份（不参与自动淘汰，不会被系统删除）"
          >
            <Clock size={11} /> 立即备份
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="text-11 text-ink-400 leading-relaxed bg-ink-850 border border-ink-700 rounded-lg px-3 py-2">
            打开项目时每 5 分钟自动滚动备份（最多 {db.MAX_AUTO_BACKUPS} 份）；每天首次打开额外生成 1 份每日备份（最多 {db.MAX_DAILY_BACKUPS} 份）；
            <span className="text-ink-200">手动「立即备份」不设上限，不会被自动删除</span>。删除项目不会删除这些备份。
            <br />
            这些备份都只存在这台电脑的软件数据文件里。想多一层保险，可用每行的 <span className="text-ink-200">↑ 导出</span> 把某一份存成独立文件，放进云盘或移动硬盘。
          </div>

          {/* #012：份数过多时的体验提示 —— 便携版是单 JSON 全量写盘，膨胀会直接拖慢保存 */}
          {tooMany && (
            <div className="flex items-start gap-2 text-11 leading-relaxed bg-amber/10 border border-amber/30 rounded-lg px-3 py-2">
              <AlertTriangle size={13} className="text-amber shrink-0 mt-px" />
              <span className="text-amber">
                当前共 <span className="font-semibold">{backups.length} 份</span>备份，约 {totalMB.toFixed(1)} MB。
                <span className="font-semibold">备份过多可能影响使用体验</span>——数据文件会持续变大，打开项目、自动保存都会变慢。
                建议保留真正需要的节点，删除其余旧备份。
              </span>
            </div>
          )}

          <Group id="manual" title="手动备份" icon={<ShieldCheck size={13} className="text-amber" />} items={manual} hint="不设上限，不会自动删除" />
          <Group id="daily" collapsible title="每日自动备份" icon={<CalendarDays size={13} className="text-amber" />} items={daily} hint={`最多 ${db.MAX_DAILY_BACKUPS} 份`} />
          <Group id="auto" collapsible title="5 分钟自动备份" icon={<Clock size={13} className="text-amber" />} items={auto} hint={`滚动保留最多 ${db.MAX_AUTO_BACKUPS} 份`} />

          {/* v1.3 迁移 / 换机：加密迁移包导出导入 */}
          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Lock size={13} className="text-amber" />
              <span className="text-13 font-semibold text-ink-100">迁移 / 换机</span>
              <span className="text-11 text-ink-500">把整个项目打包带走，换设备完整恢复</span>
            </div>
            <div className="text-11 text-ink-400 leading-relaxed mb-2.5">
              导出为「迁移包」文件（含全部卷 / 章 / 设定 / 角色卡）。可设密码加密（AES-GCM，密码不出本机）；
              在另一台设备的同款软件里导入即可完整恢复。自动备份（上方）仅在本机滚动保留，迁移包用于跨设备搬运。
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="bare"
                onClick={exportMigration}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-12 text-amber border border-amber/30 rounded-lg hover:bg-amber/10 disabled:opacity-50"
                title="导出整个项目为迁移包（可加密）"
              >
                <Upload size={12} /> 导出迁移包（可选加密）
              </Button>
              <Button variant="bare"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-12 text-ink-100 border border-ink-600 rounded-lg hover:bg-ink-800 disabled:opacity-50"
                title="从迁移包文件恢复项目（会新建一个项目）"
              >
                <FileDown size={12} /> 导入迁移包
              </Button>
              {/* C2：备份外置 —— 恢复回**当前项目**（与上面「导入迁移包=新建项目」不同） */}
              <Button variant="bare"
                onClick={() => backupFileInput.current?.click()}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-12 text-ink-100 border border-ink-600 rounded-lg hover:bg-ink-800 disabled:opacity-50"
                title="从「导出」出来的单份备份文件恢复**当前项目**（覆盖式）"
              >
                <FileDown size={12} /> 从备份文件恢复本项
              </Button>
            </div>
          </div>

          {/* v1.6.1：孤儿备份清理（删除项目时按约定保留备份，项目没了备份仍在，需定期清理） */}
          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Trash2 size={13} className="text-red-400" />
              <span className="text-13 font-semibold text-ink-100">孤儿备份清理</span>
              <HelpPopover title="什么是孤儿备份？" width="21rem" size={12}>
                删除项目时，其自动备份按约定会保留（防止误删后无法找回）。但项目已删除后，这些备份在软件里看不到、也无法恢复项目，只会持续占用存储。
                建议定期清理。位置：本机数据文件 AppData\Roaming\青春幻想引擎\novel-studio-data.json 的 backups 字段。
              </HelpPopover>
            </div>
            <div className="text-11 text-ink-400 leading-relaxed mb-2.5">
              {orphans.length > 0
                ? <>检测到 <span className="text-red-300 font-semibold">{orphans.length} 份</span> 属于已删除项目的备份（约 {orphansMB.toFixed(1)} MB），点击下方按钮一键清理。</>
                : '没有孤儿备份——当前全部备份都属于现存项目，无需清理。'}
            </div>
            <Button onClick={cleanOrphans}
              disabled={busy || orphans.length === 0}
              
              title="删除所有属于已删除项目的备份" variant="danger" size="md" className="flex items-center text-12 text-red-400">
              <Trash2 size={12} /> 清理孤儿备份
            </Button>
          </div>

          {!loaded && <div className="text-center text-ink-500 text-12">加载中…</div>}
          {loaded && backups.length === 0 && (
            <div className="text-center text-ink-500 text-12 py-8">还没有任何自动备份——打开项目写作一段时间后会自动生成。</div>
          )}
        </div>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
        <input ref={backupFileInput} type="file" accept=".json,application/json" className="hidden" onChange={onBackupFile} />
      </Modal>

      {/* v1.6：应用内输入弹窗（替代浏览器 prompt，桌面端可用） */}
      <PromptModal
        open={!!pwdPrompt}
        title={pwdPrompt?.kind === 'export' ? '设置迁移包密码（可选）' : '输入迁移包密码'}
        label={pwdPrompt?.kind === 'export'
          ? '留空 = 不加密，直接导出明文迁移包；加密后对方需输入同一密码才能导入。'
          : '该迁移包已加密，请输入导出时设置的密码。'}
        password
        allowEmpty={pwdPrompt?.kind === 'export'}
        confirmText={pwdPrompt?.kind === 'export' ? '导出' : '解密导入'}
        onSubmit={pwdPrompt?.kind === 'export' ? submitExportPwd : submitImportPwd}
        onCancel={() => setPwdPrompt(null)}
      />
    </>
  )
}
