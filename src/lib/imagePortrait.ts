/**
 * 角色立绘（2.4.1 · B7）—— 与头像**刻意分开**的一条管线
 *
 * 【为什么不能复用 `imageAvatar.ts`】
 * 那边是给**头像**用的：`fitSquare()` **强制居中裁成正方形**、压到 256×256。
 * 它的注释里自己就写着「竖图（如 9:16）会被裁掉左右两侧，想保留全身就别拿竖图当头像」——
 * 立绘要的恰恰是"保留全身"，套上去只会剩中间一块。所以这里单独做。
 *
 * 【与头像的三点不同】
 *   ① **不裁剪**：等比缩放到目标框内（长边贴合），人物不会缺胳膊少腿；
 *   ② **更保真**：目标 512×910（约 9:16）+ WebP q=0.9（头像是 0.85）；
 *   ③ **有体积上限但优先保画质**：超限时**阶梯降质量**（0.9 → 0.82 → 0.74），而不是一刀切压狠。
 *
 * 【体积账（为什么上限是 200KB）】
 * 桌面版**整库就是一个 JSON**、云同步载荷也是整库。按 200KB/张算，30 个角色 ≈ 6MB —— 可以接受；
 * 若放到 400KB，30 角色就 12MB，同步与备份会明显变沉。所以上限定在 200KB 并**显示已用体积**给作者。
 */
import { PORTRAIT_ACCEPT, PORTRAIT_MAX_INPUT_BYTES, PORTRAIT_SIZE, PORTRAIT_TARGET_BYTES } from './portraitSpec'

/** 等比缩放：把 (w,h) 放进 (tw,th) 内，返回缩放后的尺寸（至少 1px） */
export function fitInside(w: number, h: number, tw: number, th: number): { w: number; h: number } {
  const width = Math.max(1, Math.floor(w || 0))
  const height = Math.max(1, Math.floor(h || 0))
  const scale = Math.min(tw / width, th / height)
  // 不放大：小图保持原尺寸，避免糊成一片
  const s = Math.min(1, scale)
  return { w: Math.max(1, Math.round(width * s)), h: Math.max(1, Math.round(height * s)) }
}

/** 输入体检（原因直接展示给作者） */
export function isAcceptablePortrait(f: { size: number; type: string }): { ok: boolean; reason?: string } {
  if (!f.type.startsWith('image/')) return { ok: false, reason: '请选择图片文件（PNG / JPG / WebP）' }
  if (f.size <= 0) return { ok: false, reason: '这个文件是空的，换一张试试' }
  if (f.size > PORTRAIT_MAX_INPUT_BYTES) {
    return { ok: false, reason: `原图请控制在 ${PORTRAIT_MAX_INPUT_BYTES / 1024 / 1024}MB 以内（会自动等比缩放）` }
  }
  return { ok: true }
}

/** dataURL 的近似字节数（base64 膨胀约 4/3） */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',')
  if (i < 0) return 0
  const b64 = dataUrl.slice(i + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/**
 * 质量阶梯：先给足画质，超限才降。
 * 🔴 顺序与"为什么"都写在这里 —— 别在组件里另写一套（规格说明与实现必须同源）。
 */
export const PORTRAIT_QUALITY_STEPS = [0.9, 0.82, 0.74] as const

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

/**
 * 缩放到目标框内并导出，**按质量阶梯直到满足体积上限**。
 * 若最低档仍超限，返回最低档结果（**不继续压** —— 再压就该糊了，宁可让作者自己换小一点的图）。
 */
function shrinkPortrait(dataUrl: string): Promise<{ dataUrl: string; bytes: number; quality: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const srcW = img.naturalWidth || img.width
        const srcH = img.naturalHeight || img.height
        const { w, h } = fitInside(srcW, srcH, PORTRAIT_SIZE.w, PORTRAIT_SIZE.h)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('画布不可用')); return }
        // 缩放时给点质量感（默认插值在大幅缩小时偏糊）
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, w, h)

        let last = { dataUrl: canvas.toDataURL('image/webp', PORTRAIT_QUALITY_STEPS[0]), quality: PORTRAIT_QUALITY_STEPS[0] as number }
        // 环境不支持 webp 时 toDataURL 会静默回落 png（体积大得多）→ 换 JPEG
        if (!last.dataUrl.startsWith('data:image/webp')) {
          last = { dataUrl: canvas.toDataURL('image/jpeg', PORTRAIT_QUALITY_STEPS[0]), quality: PORTRAIT_QUALITY_STEPS[0] }
        }
        let bytes = dataUrlBytes(last.dataUrl)
        for (const q of PORTRAIT_QUALITY_STEPS.slice(1)) {
          if (bytes <= PORTRAIT_TARGET_BYTES) break
          const next = last.dataUrl.startsWith('data:image/webp')
            ? canvas.toDataURL('image/webp', q)
            : canvas.toDataURL('image/jpeg', q)
          const nb = dataUrlBytes(next)
          if (nb < bytes) { last = { dataUrl: next, quality: q }; bytes = nb }
        }
        resolve({ ...last, bytes })
      } catch (e) {
        reject(e instanceof Error ? e : new Error('处理图片失败'))
      }
    }
    img.onerror = () => reject(new Error('图片解码失败，可能不是常见的图片格式'))
    img.src = dataUrl
  })
}

export interface PortraitResult {
  /** 可直接入库的 dataURL */
  dataUrl: string
  bytes: number
  /** 实际使用的质量档（供 UI 提示"为了控制体积用了哪一档"） */
  quality: number
  /** 是否因为体积上限而降过质量 */
  downscaled: boolean
}

/** 选一张图 → 可直接入库的立绘 dataURL。校验不过 / 处理失败都抛错，由调用方 toast */
export async function readPortraitFile(file: File): Promise<PortraitResult> {
  const check = isAcceptablePortrait(file)
  if (!check.ok) throw new Error(check.reason ?? '这张图不能用作立绘')
  const raw = await readAsDataURL(file)
  const r = await shrinkPortrait(raw)
  return { ...r, downscaled: r.quality !== PORTRAIT_QUALITY_STEPS[0] }
}

export { PORTRAIT_ACCEPT, PORTRAIT_MAX_INPUT_BYTES, PORTRAIT_SIZE, PORTRAIT_TARGET_BYTES }
