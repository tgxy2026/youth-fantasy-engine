import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as db from '../lib/db'
import { encryptJSON, decryptJSON, isEncrypted } from '../lib/crypto'
import { Trash2, RotateCcw, Clock, CalendarDays, ShieldCheck, Upload, FileDown, Lock, AlertTriangle } from 'lucide-react'
import PromptModal from './PromptModal'
import { confirmDialog, showToast } from './dialogs'
import { downloadBlob } from '../lib/zip'
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

  const load = async () => {
    const list = await db.listBackups(projectId)
    setBackups(list)
    setLoaded(true)
  }
  useEffect(() => { load() }, [projectId])

  // v1.6.1：孤儿备份（项目已删除但备份按约定保留）统计与清理
  const [orphans, setOrphans] = useState<db.BackupRecord[]>([])
  useEffect(() => {
    void db.listOrphanBackups().then(setOrphans).catch(() => {})
  }, [])
  const orphansMB = useMemo(() => orphans.reduce((s, b) => s + JSON.stringify(b.bundle).length, 0) / 1024 / 1024, [orphans])
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

  const daily = backups.filter(b => b.kind === 'daily')
  const auto = backups.filter(b => b.kind === 'auto5min')
  const manual = backups.filter(b => b.kind === 'manual')

  // #020：备份 bundle 体积较大，每次渲染都对每份 backup 做 JSON.stringify 很浪费。
  // 用 useMemo 缓存「id → bundle 字节数」映射，仅在备份列表变化时重算。
  const sizeMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of backups) m.set(b.id, JSON.stringify(b.bundle).length)
    return m
  }, [backups])
  const sizeOf = (b: db.BackupRecord) => {
    const kb = (sizeMap.get(b.id) ?? 0) / 1024
    return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`
  }
  // #012：份数过多会让数据文件变大、开关与保存变慢（便携版单 JSON 全量写盘尤其明显）
  const totalMB = [...sizeMap.values()].reduce((s, n) => s + n, 0) / 1024 / 1024
  const MANY_BACKUPS = 40
  const tooMany = backups.length > MANY_BACKUPS

  const Group = ({ title, icon, items, hint }: { title: string; icon: ReactNode; items: db.BackupRecord[]; hint: string }) => (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-[13px] font-semibold text-ink-100">{title}</span>
        <span className="text-[11px] text-ink-500">{items.length} 份 · {hint}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-ink-600 px-2 py-2">暂无备份</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(b => (
            <div key={b.id} className="flex items-center gap-3 bg-ink-850 border border-ink-700 rounded-lg px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink-100">{b.label}</div>
                <div className="text-[10px] text-ink-500">{new Date(b.createdAt).toLocaleString()} · {sizeOf(b)}</div>
              </div>
              <Button variant="bare"
                onClick={() => restore(b)}
                disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-emerald-400 border border-emerald-500/30 rounded-md hover:bg-emerald-500/10 disabled:opacity-50"
                title="用此版本覆盖当前项目"
              >
                <RotateCcw size={11} /> 恢复
              </Button>
              <Button variant="bare"
                onClick={() => remove(b.id)}
                disabled={busy}
                className="p-1.5 text-ink-500 hover:text-red-400 disabled:opacity-50"
                title="删除备份"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )

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
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-amber border border-amber/30 rounded-lg hover:bg-amber/10 disabled:opacity-50"
            title="立即生成一份手动备份（不参与自动淘汰，不会被系统删除）"
          >
            <Clock size={11} /> 立即备份
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="text-[11px] text-ink-400 leading-relaxed bg-ink-850 border border-ink-700 rounded-lg px-3 py-2">
            打开项目时每 5 分钟自动滚动备份（最多 {db.MAX_AUTO_BACKUPS} 份）；每天首次打开额外生成 1 份每日备份（最多 {db.MAX_DAILY_BACKUPS} 份）；
            <span className="text-ink-200">手动「立即备份」不设上限，不会被自动删除</span>。删除项目不会删除这些备份。
          </div>

          {/* #012：份数过多时的体验提示 —— 便携版是单 JSON 全量写盘，膨胀会直接拖慢保存 */}
          {tooMany && (
            <div className="flex items-start gap-2 text-[11px] leading-relaxed bg-amber/10 border border-amber/30 rounded-lg px-3 py-2">
              <AlertTriangle size={13} className="text-amber shrink-0 mt-px" />
              <span className="text-amber">
                当前共 <span className="font-semibold">{backups.length} 份</span>备份，约 {totalMB.toFixed(1)} MB。
                <span className="font-semibold">备份过多可能影响使用体验</span>——数据文件会持续变大，打开项目、自动保存都会变慢（便携版尤其明显）。
                建议保留真正需要的节点，删除其余旧备份。
              </span>
            </div>
          )}

          <Group title="手动备份" icon={<ShieldCheck size={13} className="text-amber" />} items={manual} hint="不设上限，不会自动删除" />
          <Group title="每日自动备份" icon={<CalendarDays size={13} className="text-amber" />} items={daily} hint={`最多 ${db.MAX_DAILY_BACKUPS} 份`} />
          <Group title="5 分钟自动备份" icon={<Clock size={13} className="text-amber" />} items={auto} hint={`滚动保留最多 ${db.MAX_AUTO_BACKUPS} 份`} />

          {/* v1.3 迁移 / 换机：加密迁移包导出导入 */}
          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Lock size={13} className="text-amber" />
              <span className="text-[13px] font-semibold text-ink-100">迁移 / 换机</span>
              <span className="text-[11px] text-ink-500">把整个项目打包带走，换设备完整恢复</span>
            </div>
            <div className="text-[11px] text-ink-400 leading-relaxed mb-2.5">
              导出为「迁移包」文件（含全部卷 / 章 / 设定 / 角色卡）。可设密码加密（AES-GCM，密码不出本机）；
              在另一台设备的同款软件里导入即可完整恢复。自动备份（上方）仅在本机滚动保留，迁移包用于跨设备搬运。
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="bare"
                onClick={exportMigration}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-[12px] text-amber border border-amber/30 rounded-lg hover:bg-amber/10 disabled:opacity-50"
                title="导出整个项目为迁移包（可加密）"
              >
                <Upload size={12} /> 导出迁移包（可选加密）
              </Button>
              <Button variant="bare"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-[12px] text-ink-100 border border-ink-600 rounded-lg hover:bg-ink-800 disabled:opacity-50"
                title="从迁移包文件恢复项目"
              >
                <FileDown size={12} /> 导入迁移包
              </Button>
            </div>
          </div>

          {/* v1.6.1：孤儿备份清理（删除项目时按约定保留备份，项目没了备份仍在，需定期清理） */}
          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Trash2 size={13} className="text-red-400" />
              <span className="text-[13px] font-semibold text-ink-100">孤儿备份清理</span>
              <HelpPopover title="什么是孤儿备份？" width="21rem" size={12}>
                删除项目时，其自动备份按约定会保留（防止误删后无法找回）。但项目已删除后，这些备份在软件里看不到、也无法恢复项目，只会持续占用存储。
                建议定期清理。三种存储形态的位置：网页版 = 浏览器 IndexedDB 库 novel-studio 的 backups 表；便携版 = 数据 JSON 文件的 backups 字段；桌面版 = AppData\Roaming\青春幻想引擎\novel-studio-data.json 的 backups 字段。
              </HelpPopover>
            </div>
            <div className="text-[11px] text-ink-400 leading-relaxed mb-2.5">
              {orphans.length > 0
                ? <>检测到 <span className="text-red-300 font-semibold">{orphans.length} 份</span> 属于已删除项目的备份（约 {orphansMB.toFixed(1)} MB），点击下方按钮一键清理。</>
                : '没有孤儿备份——当前全部备份都属于现存项目，无需清理。'}
            </div>
            <Button onClick={cleanOrphans}
              disabled={busy || orphans.length === 0}
              
              title="删除所有属于已删除项目的备份" variant="danger" size="md" className="flex items-center text-[12px] text-red-400">
              <Trash2 size={12} /> 清理孤儿备份
            </Button>
          </div>

          {!loaded && <div className="text-center text-ink-500 text-[12px]">加载中…</div>}
          {loaded && backups.length === 0 && (
            <div className="text-center text-ink-500 text-[12px] py-8">还没有任何自动备份——打开项目写作一段时间后会自动生成。</div>
          )}
        </div>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
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
