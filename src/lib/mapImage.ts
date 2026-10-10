/**
 * 自定义地图底图（2.4.1 · B8）—— 图片处理
 *
 * 与角色立绘（`imagePortrait.ts`）同一套思路（等比缩放**不裁切** + 质量阶梯），但目标不同：
 *   ① **长边 ≤ 1600**（地图是铺满画布看的，比立绘需要更细）；
 *   ② 质量 **q0.88**；
 *   ③ 上限 **800KB**（地图张数少 —— 一个项目通常 1~5 张 —— 所以可以比立绘宽松）。
 *
 * 【为什么地图可以放宽到 800KB】
 * 桌面版整库是一个 JSON。立绘上限压到 200KB 是因为可能有几十个角色；
 * 地图通常只有几张，5 张 × 800KB = 4MB，可接受。**但也不能不设限** ——
 * 一张手机拍的 8MB 原图直接入库，云同步会明显变沉。
 *
 * ⚠️ 这里只负责"把图变成可入库的 dataURL"；**渲染与缩放交互在 `GeoMapEditor`**
 *    （图片作为 svg 里的一个 `<image>` 层，直接复用地图既有的 `view{x,y,k}` 变换 —— 不另搞一套 pan/zoom）。
 */
import { dataUrlBytes } from '@/lib/imagePortrait'

/** 原图体积上限（超出直接拒绝） */
export const MAP_IMAGE_MAX_INPUT_BYTES = 16 * 1024 * 1024
/** 处理后长边上限 */
export const MAP_IMAGE_MAX_SIDE = 1600
/** 处理后体积上限 */
const MAP_IMAGE_TARGET_BYTES = 800 * 1024
/** 质量阶梯：先保画质，超限才降 */
export const MAP_IMAGE_QUALITY_STEPS = [0.88, 0.8, 0.7] as const
export const MAP_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'

/** 只缩不放：把 (w,h) 约束到长边 ≤ maxSide 内，保持比例 */
export function fitLongSide(w: number, h: number, maxSide: number): { w: number; h: number } {
  const width = Math.max(1, Math.floor(w || 0))
  const height = Math.max(1, Math.floor(h || 0))
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { w: width, h: height }
  const s = maxSide / longest
  return { w: Math.max(1, Math.round(width * s)), h: Math.max(1, Math.round(height * s)) }
}

export function isAcceptableMapImage(f: { size: number; type: string }): { ok: boolean; reason?: string } {
  if (!f.type.startsWith('image/')) return { ok: false, reason: '请选择图片文件（PNG / JPG / WebP）' }
  if (f.size <= 0) return { ok: false, reason: '这个文件是空的，换一张试试' }
  if (f.size > MAP_IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, reason: `原图请控制在 ${MAP_IMAGE_MAX_INPUT_BYTES / 1024 / 1024}MB 以内（会自动缩放）` }
  }
  return { ok: true }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

function shrink(dataUrl: string): Promise<{ dataUrl: string; bytes: number; quality: number; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const srcW = img.naturalWidth || img.width
        const srcH = img.naturalHeight || img.height
        const { w, h } = fitLongSide(srcW, srcH, MAP_IMAGE_MAX_SIDE)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('画布不可用')); return }
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, w, h)

        const isWebp = (s: string) => s.startsWith('data:image/webp')
        let best = { dataUrl: canvas.toDataURL('image/webp', MAP_IMAGE_QUALITY_STEPS[0]), quality: MAP_IMAGE_QUALITY_STEPS[0] as number }
        if (!isWebp(best.dataUrl)) {
          best = { dataUrl: canvas.toDataURL('image/jpeg', MAP_IMAGE_QUALITY_STEPS[0]), quality: MAP_IMAGE_QUALITY_STEPS[0] }
        }
        let bytes = dataUrlBytes(best.dataUrl)
        for (const q of MAP_IMAGE_QUALITY_STEPS.slice(1)) {
          if (bytes <= MAP_IMAGE_TARGET_BYTES) break
          const next = isWebp(best.dataUrl) ? canvas.toDataURL('image/webp', q) : canvas.toDataURL('image/jpeg', q)
          const nb = dataUrlBytes(next)
          if (nb < bytes) { best = { dataUrl: next, quality: q }; bytes = nb }
        }
        resolve({ ...best, bytes, w, h })
      } catch (e) {
        reject(e instanceof Error ? e : new Error('处理图片失败'))
      }
    }
    img.onerror = () => reject(new Error('图片解码失败，可能不是常见的图片格式'))
    img.src = dataUrl
  })
}

export interface MapImageResult {
  dataUrl: string
  bytes: number
  quality: number
  /** 处理后的像素尺寸（渲染时按它定世界坐标范围） */
  w: number
  h: number
  downscaled: boolean
}

/** 选一张图 → 可直接入库的底图 dataURL */
export async function readMapImageFile(file: File): Promise<MapImageResult> {
  const check = isAcceptableMapImage(file)
  if (!check.ok) throw new Error(check.reason ?? '这张图不能用作底图')
  const raw = await readAsDataURL(file)
  const r = await shrink(raw)
  return { ...r, downscaled: r.quality !== MAP_IMAGE_QUALITY_STEPS[0] }
}

/** 规格提示（给作者看，唯一真源） */
export const MAP_IMAGE_HINT_SPEC =
  `支持 PNG / JPG / WebP · 单张 ≤ ${MAP_IMAGE_MAX_INPUT_BYTES / 1024 / 1024}MB；`
  + `上传后长边缩到 ${MAP_IMAGE_MAX_SIDE} 以内、保持原比例（不裁切、不拉伸），`
  + `体积超过 ${Math.round(MAP_IMAGE_TARGET_BYTES / 1024)}KB 时才逐档降低压缩质量。滚轮可缩放、拖动可平移。`
