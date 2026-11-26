// ============ WCP 本地 Agent 工作区 · 宿主桥接（3.7.4 · W3）============
//
// 职责：把 `window.electronWcpWorkspace` 的 IPC 收成**永不抛**的 Promise，
// 并在「网页版 / 便携版 / 无写盘桥接」时降级为**打包下载纯 ASCII 路径的 `.zip`**（D4）。
//
// 🔴 这里不判断业务新鲜度、也不拼文件内容 —— 那些在 `wcpWorkspaceBuilder` / `wcpWorkspaceSync`。
// 🔴 桥接缺失时**不静默假装成功**：调用方必须能区分「已写盘」与「已下载 zip」。
import { downloadBlob, ZipBuilder } from '@/lib/storage/zip'
import { sanitizeWcpFileName } from '@/lib/wcp/wcpPacker'
import type { WcpWorkspacePlan } from '@/lib/wcp/wcpWorkspaceBuilder'

export interface WcpWorkspaceOutboxEntry {
  base: string
  jsonName: string
  mdName: string
  size: number
  mtimeMs: number
}

export interface WcpWorkspaceApplyResult {
  ok: boolean
  error?: string
  written?: number
  deleted?: number
  errors?: string[]
}

/** preload 注入的 IPC 接口（仅桌面版存在） */
export interface ElectronWcpWorkspaceAPI {
  defaultRoot(): Promise<{ ok: boolean; root?: string; dataPath?: string; userData?: string; error?: string }>
  diagnose(root?: string): Promise<{ ok: boolean; writable?: boolean; root?: string; error?: string; code?: string }>
  chooseRoot(): Promise<string | null>
  apply(payload: { root: string; folder: string; files: { path: string; content: string }[]; deletions: string[] }): Promise<WcpWorkspaceApplyResult>
  scan(payload: { root: string; folder: string }): Promise<{ ok: boolean; error?: string; entries?: WcpWorkspaceOutboxEntry[] }>
  read(payload: { root: string; folder: string; name: string }): Promise<{ ok: boolean; error?: string; text?: string; name?: string }>
  archive(payload: { root: string; folder: string; jsonName?: string; mdName?: string }): Promise<{ ok: boolean; error?: string; archived?: string[] }>
  reveal(payload: { root: string; folder: string }): Promise<{ ok: boolean; error?: string }>
}

/** 运行时取桥（不用模块级常量：测试可注入 mock window） */
export function wcpWorkspaceBridge(): ElectronWcpWorkspaceAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronWcpWorkspace ?? null
}

export function hasWcpWorkspaceBridge(): boolean {
  return !!wcpWorkspaceBridge()
}

/** 默认工作区根（数据文件同级 `wcp-workspaces/`）；无桥接时返回空串 */
export async function workspaceDefaultRoot(): Promise<string> {
  const api = wcpWorkspaceBridge()
  if (!api) return ''
  const r = await api.defaultRoot().catch(() => null)
  return r?.ok && r.root ? r.root : ''
}

export async function workspaceDiagnose(root?: string): Promise<{ ok: boolean; writable: boolean; root: string; error: string }> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, writable: false, root: root ?? '', error: '当前形态没有本地写盘桥接，可改用「下载离线工作区 .zip」。' }
  const r = await api.diagnose(root).catch(e => ({ ok: false, writable: false, root: root ?? '', error: String(e) }))
  return { ok: !!r.ok, writable: !!r.writable, root: r.root ?? root ?? '', error: r.error ?? '' }
}

export async function workspaceChooseRoot(): Promise<string | null> {
  const api = wcpWorkspaceBridge()
  if (!api) return null
  return api.chooseRoot().catch(() => null)
}

export async function workspaceReveal(root: string, folder: string): Promise<{ ok: boolean; error: string }> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, error: '当前形态没有本地工作区。' }
  const r = await api.reveal({ root, folder }).catch(e => ({ ok: false, error: String(e) }))
  return { ok: !!r.ok, error: r.error ?? '' }
}

/** 落盘一份增量计划（永不抛：失败以 ok:false 返回，调用方照实提示） */
export async function workspaceApplyPlan(root: string, folder: string, plan: WcpWorkspacePlan): Promise<WcpWorkspaceApplyResult> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, error: '当前形态没有本地写盘桥接。' }
  return api.apply({
    root,
    folder,
    files: plan.toWrite.map(w => ({ path: w.path, content: w.content })),
    deletions: plan.toDelete,
  }).catch(e => ({ ok: false, error: String(e) }))
}

export async function workspaceScanOutbox(root: string, folder: string): Promise<{ ok: boolean; error: string; entries: WcpWorkspaceOutboxEntry[] }> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, error: '', entries: [] }
  const r = await api.scan({ root, folder }).catch(e => ({ ok: false, error: String(e), entries: [] }))
  return { ok: !!r.ok, error: r.error ?? '', entries: r.entries ?? [] }
}

export async function workspaceReadOutbox(root: string, folder: string, name: string): Promise<{ ok: boolean; error: string; text: string }> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, error: '当前形态不能读取本地收件箱。', text: '' }
  const r = await api.read({ root, folder, name }).catch(e => ({ ok: false, error: String(e), text: '' }))
  return { ok: !!r.ok, error: r.error ?? '', text: r.text ?? '' }
}

export async function workspaceArchiveOutbox(
  root: string, folder: string, names: { jsonName?: string; mdName?: string },
): Promise<{ ok: boolean; error: string; archived: string[] }> {
  const api = wcpWorkspaceBridge()
  if (!api) return { ok: false, error: '当前形态不能归档本地收件箱。', archived: [] }
  const r = await api.archive({ root, folder, jsonName: names.jsonName, mdName: names.mdName })
    .catch(e => ({ ok: false, error: String(e), archived: [] }))
  return { ok: !!r.ok, error: r.error ?? '', archived: r.archived ?? [] }
}

function dateStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 网页 / 便携 / 无桥接时的兜底：把同一份虚拟目录结构打成 `.zip` 下载（D4）。
 *
 * 🔴 包内**所有路径纯 ASCII**（`wcp-workspace-<pid6>/...`）：`ZipBuilder` 不置 UTF-8 标志位，
 *    中文路径在 Windows 资源管理器里解压会乱码。书名只用于 zip 文件名（浏览器下载不受影响）。
 */
export function downloadWcpWorkspaceZip(
  files: readonly { path: string; content: string }[],
  projectName: string,
  projectId: string,
): void {
  const pid = String(projectId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 6) || '000000'
  const root = `wcp-workspace-${pid}`
  const zip = new ZipBuilder()
  for (const file of files) {
    zip.add(`${root}/${file.path}`, file.content)
  }
  zip.add(`${root}/outbox/`, '')
  const filename = `${sanitizeWcpFileName(projectName || '未命名作品')}-WCP工作区-${dateStamp(Date.now())}.zip`
  const bytes = zip.build()
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  downloadBlob(filename, new Blob([buf], { type: 'application/zip' }))
}
