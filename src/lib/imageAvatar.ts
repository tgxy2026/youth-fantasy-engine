/**
 * 酒馆模式 · 头像（批次 8；调研稿 C3「立绘 / 表情」的**轻量部分**）
 *
 * 【为什么必须压缩，不能像封面那样直接 readAsDataURL】
 * 头像存成 dataURL 进库（角色卡 → 全局 meta 的 `tavern.free.char.<id>`；我的档案 → `tavern.settings.profile`）。
 * 桌面版**整库就是一个 JSON**、云同步载荷也是整库 —— 一张 2MB 的原图 base64 后约 2.7MB，
 * 几张卡就能把库撑到几十兆，同步直接崩。而头像最大也就渲染到 48px（详情页 64px），
 * 256×256 在 Retina 下还有 5 倍余量，足够清晰。
 *
 * 【为什么居中裁剪而不是拉伸】
 * 头像显示成圆形。拉伸会把人物压扁/拉长 —— 宁可裁掉两侧，也不要一张变形的脸。
 *
 * 【兜底】
 * 画布不可用（极老环境）或图片解码失败时 → 回落成原图 dataURL（仍受输入上限约束），
 * 结果是"头像大一点"，而不是"设不上头像"。
 */

/** 单张输入的体积上限（原图） */
export const AVATAR_MAX_INPUT_BYTES = 4 * 1024 * 1024
/** 压缩后的边长（正方形） */
export const AVATAR_SIZE = 256
/** 可接受的文件选择范围 */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * 给作者看的**图片规格建议**（唯一真源）。
 *
 * 🔴 别在组件里各写一份：角色卡片与「我的档案」两处必须一字不差 ——
 * 规格说明与实现不一致，比没有说明更坏（作者会按错的比例去裁图，然后发现脸被切了）。
 * 这里的每个数字都能在下面找到出处：裁方＝`fitSquare`、256＝`AVATAR_SIZE`、4MB＝`AVATAR_MAX_INPUT_BYTES`。
 *
 * 为什么推荐「512 以上」而不是正好 256：源图给 2 倍余量，将来把显示尺寸调大（或在
 * 高分屏上放大看）才不会糊；再大就没意义了 —— 入库前一律压到 256。
 */
export const AVATAR_HINT_SPEC =
  `建议 1:1 正方形 · ${AVATAR_SIZE * 2}×${AVATAR_SIZE * 2} 以上 · PNG / JPG / WebP · 单张 ≤ ${AVATAR_MAX_INPUT_BYTES / 1024 / 1024}MB。`
  + `上传后自动居中裁成方形并压到 ${AVATAR_SIZE}×${AVATAR_SIZE}（通常只剩 10~30KB）；竖图（如 9:16）会被裁掉左右两侧，想保留全身就别拿竖图当头像。`

/** 输入体检：类型与体积。返回原因时直接展示给作者，所以文案要能看懂 */
export function isAcceptableAvatar(f: { size: number; type: string }): { ok: boolean; reason?: string } {
  if (!f.type.startsWith('image/')) return { ok: false, reason: '请选择图片文件（PNG / JPG / WebP / GIF）' }
  if (f.size <= 0) return { ok: false, reason: '这个文件是空的，换一张试试' }
  if (f.size > AVATAR_MAX_INPUT_BYTES) {
    return { ok: false, reason: `原图请控制在 ${AVATAR_MAX_INPUT_BYTES / 1024 / 1024}MB 以内（会自动裁成方形并压缩）` }
  }
  return { ok: true }
}

/**
 * 居中裁成正方形的取景框（不拉伸）。
 * 抽成纯函数是为了能被单测覆盖 —— 画布部分在 Node 里跑不了，取景这一步才是容易算错的地方。
 */
export function fitSquare(w: number, h: number): { sx: number; sy: number; size: number } {
  const width = Math.max(1, Math.floor(w || 0))
  const height = Math.max(1, Math.floor(h || 0))
  const size = Math.min(width, height)
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size }
}

/**
 * 名字首字（无头像时的回退）。
 * 用 `Array.from` 而不是 `slice(0,1)`：中文在 BMP 内无妨，但 emoji 名字会被 slice 切成半个字符。
 */
export function avatarInitial(name: string): string {
  const s = String(name ?? '').trim()
  if (!s) return '?'
  return Array.from(s)[0] ?? '?'
}

/**
 * 头像兜底上要显示的文字 —— **名字，不是姓氏**（老大 2026-09-15 反馈）。
 *
 * 起因：只取首字时，「阿禾 / 苏晴」在同一场戏里的头像长得一模一样，
 * 作者根本分不清谁在说话 —— 而多角色同场正是最需要头像的场合。
 *
 * 为什么封顶 2 字：圆形头像只有 16–36px，塞 3 个字会糊成一团；
 * 而中文姓名 2 字已足以区分（3 字名的重名概率极低，且悬停 title 里有全名）。
 * 字数是按 `Array.from` 数**字符**而非码元 —— emoji 名字不会被切半个（同 avatarInitial）。
 */
export function avatarLabel(name: string, max = 2): string {
  const s = String(name ?? '').trim()
  if (!s) return '?'
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

/** 居中裁方 → 缩到 AVATAR_SIZE → 导出（优先 WebP 保透明，不支持则 JPEG） */
function shrinkToSquare(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const { sx, sy, size } = fitSquare(img.naturalWidth || img.width, img.naturalHeight || img.height)
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE
        canvas.height = AVATAR_SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('画布不可用')); return }
        ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
        const webp = canvas.toDataURL('image/webp', 0.85)
        // 个别环境不认 webp，toDataURL 会静默回落成 png —— 用前缀判一下，再决定要不要改 JPEG
        resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88))
      } catch (e) {
        reject(e instanceof Error ? e : new Error('处理图片失败'))
      }
    }
    img.onerror = () => reject(new Error('图片解码失败，可能不是常见的图片格式'))
    img.src = dataUrl
  })
}

/** 选一张图 → 可直接存库的 dataURL。校验不过 / 压缩失败都会抛错，由调用方 toast */
export async function readAvatarFile(file: File): Promise<string> {
  const check = isAcceptableAvatar(file)
  if (!check.ok) throw new Error(check.reason ?? '这张图不能用作头像')
  const raw = await readAsDataURL(file)
  try {
    return await shrinkToSquare(raw)
  } catch {
    return raw
  }
}
