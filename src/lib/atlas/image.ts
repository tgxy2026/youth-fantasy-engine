/**
 * 图鉴主图（3.1.3 · 方案 §6.2）：把用户选的图压成可入库的 `AtlasImage`。
 *
 * 【规格（与方案逐条对应）】
 *   · 接受 PNG / JPEG / WebP，原文件 ≤ 8MiB；**拒 SVG**（可执行内容，方案 §6.3）
 *   · 等比缩到**最长边 ≤ 1024px**，不放大、不裁切、保留透明背景
 *   · 编码后目标 ≤ 200KiB：先逐档降质，仍超再缩尺寸；**达不到就拒绝**，不返回超限结果
 *
 * 🔴 复用 `imagePortrait` 的 `fitInside` / `dataUrlBytes`：那两处是"不放大 + 字节口径"的单一真源，
 *    各写一份迟早会漂移（立绘那边踩过"规格与实现不同源"的坑，见 portraitSpec 头注）。
 */
import { dataUrlBytes, fitInside } from '@/lib/media/imagePortrait'
import type { AtlasImage } from './types'

/** 最长边上限 */
export const ATLAS_IMAGE_MAX_EDGE = 1024
/** 单张编码后体积上限（方案 §6.2） */
export const ATLAS_IMAGE_TARGET_BYTES = 200 * 1024
/** 原图体积上限 */
export const ATLAS_IMAGE_MAX_INPUT_BYTES = 8 * 1024 * 1024
export const ATLAS_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'

/** 质量阶梯（先保画质，超限才往下走） */
const QUALITY_STEPS = [0.92, 0.84, 0.76, 0.68, 0.6, 0.5] as const
/** 质量到底仍超限时的尺寸阶梯（相对最长边） */
const EDGE_STEPS = [1, 0.85, 0.7] as const

export type AtlasImageResult =
  | { ok: true; image: AtlasImage; downscaled: boolean }
  | { ok: false; reason: string }

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，可能不是常见的图片格式'))
    img.src = src
  })
}

/** 用某个 MIME 编码（webp 不可用时由调用方回落） */
function encode(canvas: HTMLCanvasElement, mime: string, quality: number): string {
  return canvas.toDataURL(mime, quality)
}

/**
 * 读文件 → 压缩 → 返回可入库的 `AtlasImage`。
 * 失败一律返回 **给人看的原因**（界面直接展示，不吞错）。
 */
export async function readAtlasImage(file: File): Promise<AtlasImageResult> {
  const type = (file.type || '').toLowerCase()
  if (type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    return { ok: false, reason: '不支持 SVG（可执行内容有安全风险），请用 PNG / JPG / WebP' }
  }
  if (!/^image\/(png|jpeg|webp)$/.test(type)) {
    return { ok: false, reason: '请选择 PNG / JPG / WebP 图片' }
  }
  if (file.size <= 0) return { ok: false, reason: '这个文件是空的，换一张试试' }
  if (file.size > ATLAS_IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, reason: `原图请控制在 ${ATLAS_IMAGE_MAX_INPUT_BYTES / 1024 / 1024}MB 以内（会自动等比缩放）` }
  }

  let srcUrl: string
  let img: HTMLImageElement
  try {
    srcUrl = await readAsDataUrl(file)
    img = await loadImage(srcUrl)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '图片读取失败' }
  }

  const srcW = img.naturalWidth || img.width
  const srcH = img.naturalHeight || img.height
  if (!srcW || !srcH) return { ok: false, reason: '图片尺寸异常，换一张试试' }

  // 优先 webp（体积小且支持透明）；环境不支持时 toDataURL 会静默回落 png —— 需要识别出来
  const probe = document.createElement('canvas').toDataURL('image/webp', 0.8)
  const webpOk = probe.startsWith('data:image/webp')

  let best: { dataUrl: string; bytes: number } | null = null
  for (const edge of EDGE_STEPS) {
    const maxEdge = Math.round(ATLAS_IMAGE_MAX_EDGE * edge)
    const { w, h } = fitInside(srcW, srcH, maxEdge, maxEdge)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return { ok: false, reason: '画布不可用（浏览器环境异常）' }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, w, h)

    for (const q of QUALITY_STEPS) {
      const dataUrl = webpOk ? encode(canvas, 'image/webp', q) : encode(canvas, 'image/png', q)
      const bytes = dataUrlBytes(dataUrl)
      if (!best || bytes < best.bytes) best = { dataUrl, bytes }
      if (bytes <= ATLAS_IMAGE_TARGET_BYTES) {
        return {
          ok: true,
          image: {
            dataUrl,
            mime: (webpOk ? 'image/webp' : 'image/png') as AtlasImage['mime'],
            width: w,
            height: h,
            bytes,
          },
          downscaled: edge !== 1 || q !== QUALITY_STEPS[0],
        }
      }
    }
  }

  // 最低档仍超限：**拒绝**（方案 §6.2：不能返回超限结果继续写库）
  return {
    ok: false,
    reason: `这张图压到最小仍有 ${Math.round((best?.bytes ?? 0) / 1024)}KB（上限 ${Math.round(ATLAS_IMAGE_TARGET_BYTES / 1024)}KB），请换一张或先自行缩小`,
  }
}

/** 给作者看的规格说明（与上面的常量同源） */
export const ATLAS_IMAGE_HINT =
  `推荐横图或方图 · PNG / JPG / WebP · 单张 ≤ ${ATLAS_IMAGE_MAX_INPUT_BYTES / 1024 / 1024}MB。`
  + `上传后等比缩到最长边不超过 ${ATLAS_IMAGE_MAX_EDGE}px（不裁切、不放大，保留透明），`
  + `编码后控制在 ${Math.round(ATLAS_IMAGE_TARGET_BYTES / 1024)}KB 以内。`
