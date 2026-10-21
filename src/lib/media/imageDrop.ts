/**
 * 图片拖拽上传 · 纯逻辑（3.2.0）
 *
 * 【为什么单独一层】
 * 全项目原有 7 处图片入口（头像 / 项目封面 ×2 / 图鉴主图 / 地图底图 / 看板娘 / 人物立绘 ×2）
 * 都只有「点按钮 → 弹系统选择框」一条路。加拖拽时最怕的不是写不出 onDrop，
 * 而是**每处各写一份判断**：有的只查 size（`ProjectHub.pickCover` 原先就是这样）、
 * 有的靠处理函数抛错、有的根本不查 —— 于是「拖进去一个 .txt」在不同页签会有三种下场。
 *
 * 所以判定只在这里做一次，组件只负责把 File 交给既有的 pick 函数。
 * 本文件不碰 React、不碰 DOM 事件（`DragEvent` 只在类型层出现），可直接单测。
 */

/** 判定只需要这三个字段 —— 用结构类型而不是 `File`，Node 里也能构造样本 */
export interface DroppedFileLike {
  name: string
  type: string
  size: number
}

/** 一次拖拽的结论：要么给一张图，要么给一句作者能看懂的理由 */
export type DropPlan<T extends DroppedFileLike> =
  | { kind: 'accept'; file: T; /** 同时拖进来的其余文件数（>0 时界面提一句） */ extra: number }
  | { kind: 'reject'; reason: string }

/**
 * 这次拖拽到底带没带文件？
 *
 * 🔴 必须判，不能见到 dragover 就拦：章节树的**拖拽调序**用的是自定义 types，
 *    正文里拖动选区用的是 `text/plain`。一律 preventDefault 会把它们一起弄坏。
 *    `types` 在 dragover 阶段才可读，drop 阶段可能为空 —— 所以调用方两边都要传。
 */
export function hasFilePayload(types: readonly string[] | null | undefined): boolean {
  return Array.isArray(types) ? types.includes('Files') : false
}

/**
 * Drop 阶段判定文件时，以实际文件列表兜底。浏览器可能在 drop 事件里清空 `types`，
 * 但 `files` 仍然包含用户拖入的文件；只看 `types` 会让图片区漏接、全局防导航也失效。
 */
export function hasDroppedFilePayload(
  types: readonly string[] | null | undefined,
  fileCount: number,
): boolean {
  return hasFilePayload(types) || fileCount > 0
}

/** mime → 给作者看的短名（说明文案用，不认识就返回空串） */
const MIME_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
  'image/bmp': 'BMP',
  'image/avif': 'AVIF',
}

/** 从 `accept` 串里读出「这处到底收哪些格式」，用于拒绝时的说明（空串＝不限或不认识） */
export function acceptLabel(accept: string): string {
  const parts = accept.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.includes('image/*')) return '图片'
  const names = parts
    .map(p => MIME_LABEL[p] ?? '')
    .filter(Boolean)
  // 全都不认识（如只写了扩展名）⇒ 直接把扩展名亮出来，别硬编成"图片"
  if (names.length === 0) return parts.map(p => p.replace(/^\./, '').toUpperCase()).join(' / ')
  return Array.from(new Set(names)).join(' / ')
}

/** 扩展名兜底：有些来源（拖出压缩包、某些网盘客户端）给的 `type` 是空串 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/**
 * 扩展名 → MIME。
 * 🔴 不能省：从资源管理器拖某些网盘占位文件 / 压缩包内文件时，`File.type` 会是空串，
 *    此时只能靠扩展名判断。不认扩展名会把"明明是 PNG"的图判成"不是图片"。
 */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

/** 这张图符合这处的 accept 吗 */
export function matchAccept(f: DroppedFileLike, accept: string): boolean {
  const ext = extOf(f.name)
  // MIME 为空时按扩展名补一个 —— 后面统一按 MIME 比，避免两条判定路径出现分歧
  const mime = (f.type || '').toLowerCase() || EXT_TO_MIME[ext] || ''
  const parts = accept.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return mime.startsWith('image/') || ext !== ''
  for (const p of parts) {
    if (p === 'image/*') { if (mime.startsWith('image/')) return true; continue }
    if (p.startsWith('.')) { if (ext && ext === p.slice(1)) return true; continue }
    if (p.endsWith('/*')) { if (mime.startsWith(p.slice(0, -1))) return true; continue }
    if (mime && mime === p) return true
    // 同一格式的常见别名：image/jpg ↔ image/jpeg、image/x-png、image/pjpeg
    if (mime === 'image/jpg' && p === 'image/jpeg') return true
    if (mime === 'image/jpeg' && p === 'image/jpg') return true
    if (mime === 'image/x-png' && p === 'image/png') return true
    if (mime === 'image/pjpeg' && p === 'image/jpeg') return true
  }
  return false
}

/**
 * 拖进来的一批文件 → 用第一张（这些入口都是「一格一张图」，多拖没有意义，但要说清用了哪张）。
 *
 * 拒绝文案分三类，因为作者要采取的动作完全不同：
 *   · 拖了文件夹 ⇒ 提示"拖文件夹不行"，而不是笼统说"不是图片"（他会以为图有问题）；
 *   · 拖了别的文件（.txt/.docx）⇒ 点名文件名 + 这处收什么格式；
 *   · 空文件 ⇒ 直说空文件（网盘占位文件常见）。
 */
export function planImageDrop<T extends DroppedFileLike>(
  files: readonly T[] | null | undefined,
  accept: string,
): DropPlan<T> {
  const list = Array.isArray(files) ? files.filter(Boolean) : []
  if (list.length === 0) return { kind: 'reject', reason: '没读到文件 —— 请从文件夹里把图片拖进来' }

  const first = list[0]
  // 文件夹：浏览器给的是 size=0、type='' 的条目（展开要 DataTransferItem，不在本层处理）
  if (!first.type && first.size === 0 && !extOf(first.name)) {
    return { kind: 'reject', reason: '拖进来的是文件夹 —— 请把里面的图片文件本身拖过来' }
  }
  if (first.size <= 0) return { kind: 'reject', reason: `「${first.name}」是空文件，换一张试试` }
  if (!matchAccept(first, accept)) {
    const want = acceptLabel(accept)
    return {
      kind: 'reject',
      reason: want ? `这里只收 ${want}，而「${first.name}」不是` : `「${first.name}」不是图片文件`,
    }
  }
  return { kind: 'accept', file: first, extra: list.length - 1 }
}
