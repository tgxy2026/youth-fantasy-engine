/**
 * 本地 Agent 收件箱卡片（3.7.4 · WCP-Local）。
 *
 * 纯展示：所有扫描 / 载入 / 归档动作由 `WcpImportModal` 注入。
 * 抽成独立组件是为了让回流弹窗保持可维护体量（原弹窗已接近 600 行拆分提示线）。
 */
import { AlertTriangle, Archive, Copy, Inbox, ListChecks, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import type { WcpWorkspaceOutboxEntry } from '@/lib/wcp/wcpWorkspaceClient'

export interface WcpOutboxCardProps {
  entries: WcpWorkspaceOutboxEntry[]
  busy: boolean
  error: string
  loaded: { base: string; projectName: string } | null
  preview: { name: string; text: string } | null
  onScan: () => void
  onLoadJson: (entry: WcpWorkspaceOutboxEntry) => void
  onPreviewMd: (entry: WcpWorkspaceOutboxEntry) => void
  onCopyMd: (entry: WcpWorkspaceOutboxEntry) => void
  onLoadMd: (entry: WcpWorkspaceOutboxEntry) => void
  onArchive: () => void
  onCopyPreview: () => void
  onClosePreview: () => void
}

export default function WcpOutboxCard({
  entries, busy, error, loaded, preview,
  onScan, onLoadJson, onPreviewMd, onCopyMd, onLoadMd, onArchive, onCopyPreview, onClosePreview,
}: WcpOutboxCardProps) {
  return (
    <div className="rounded-lg border border-ink-700 yfe-surface-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Inbox size={13} className="shrink-0 text-amber" />
        <p className="text-12 font-medium text-ink-200">本地 Agent 收件箱（outbox/）</p>
        <span className="text-11 text-ink-500">
          {busy ? '正在扫描…' : entries.length ? `${entries.length} 组待处理产物` : '暂无产物'}
        </span>
        <Button variant="secondary" size="xs" className="ml-auto" onClick={onScan} disabled={busy}>
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> 重新扫描
        </Button>
      </div>
      <p className="mt-1 text-11 text-ink-500 leading-relaxed">
        本地 Agent 写入 outbox/ 的成果会列在这里。载入 `.wcp.json` 会先校验契约与 projectId，再直接比对候选；同名 `.md` 可预览或载入。
      </p>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-11 text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {!busy && entries.length === 0 && !error && (
        <p className="mt-2 rounded-md border border-ink-700 bg-ink-900/60 px-2.5 py-2 text-11 text-ink-500">
          收件箱还是空的。把上面复制的 Agent 提示词交给本地 Agent，让它把产物写到 outbox/ 即可。
        </p>
      )}

      {entries.length > 0 && (
        <div className="mt-2 max-h-52 overflow-auto space-y-1.5">
          {entries.map(entry => (
            <div key={entry.base} className="rounded-md border border-ink-700 bg-ink-900/50 px-2.5 py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-12 text-ink-200">{entry.base}</span>
                <span className="text-10 text-ink-500">{new Date(entry.mtimeMs).toLocaleString()}</span>
                {entry.jsonName && <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 text-10 text-emerald-300">JSON</span>}
                {entry.mdName && <span className="rounded border border-ink-700 bg-ink-800/60 px-1 py-0.5 text-10 text-ink-400">MD</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {entry.jsonName && (
                  <Button variant="primary" size="xs" onClick={() => onLoadJson(entry)}>
                    <ListChecks size={12} /> 载入 JSON
                  </Button>
                )}
                {entry.mdName && (
                  <>
                    <Button variant="secondary" size="xs" onClick={() => onPreviewMd(entry)}>
                      预览 MD
                    </Button>
                    <Button variant="secondary" size="xs" onClick={() => onCopyMd(entry)}>
                      <Copy size={12} /> 复制 MD
                    </Button>
                    <Button variant="secondary" size="xs" onClick={() => onLoadMd(entry)}>
                      载入 MD
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {loaded && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5">
          <span className="text-11 text-emerald-300">已载入：{loaded.base}（{loaded.projectName}）</span>
          <span className="text-11 text-ink-500">导入成功后会成对归档到 outbox/imported/。</span>
          <Button variant="secondary" size="xs" className="ml-auto" onClick={onArchive}>
            <Archive size={12} /> 立即归档
          </Button>
        </div>
      )}

      {preview && (
        <div className="mt-2 rounded-md border border-ink-700 yfe-surface-3 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-11 text-ink-300">{preview.name}</span>
            <Button variant="secondary" size="xs" onClick={onCopyPreview}>
              <Copy size={12} /> 复制
            </Button>
            <Button variant="secondary" size="xs" onClick={onClosePreview}>收起</Button>
          </div>
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-11 text-ink-400">
            {preview.text}
          </pre>
        </div>
      )}
    </div>
  )
}