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
import { PORTRAIT_ACCEPT, PORTRAIT_MAX_INPUT_BYTES, PORTRAIT_SIZE, PORTRAIT_TARGET_BYTES } from '@/lib/media/portraitSpec'
import { checkImageFile, readAsDataURL, shrinkToFit } from '@/lib/media/imageShrink'

/** dataURL 体积估算（历史调用方一直从本模块 import；真源在 imageShrink） */
export { dataUrlBytes } from '@/lib/media/imageShrink'

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
  return checkImageFile(f, PORTRAIT_MAX_INPUT_BYTES, '（会自动等比缩放）')
}

/**
 * 质量阶梯：先给足画质，超限才降。
 * 🔴 顺序与"为什么"都写在这里 —— 别在组件里另写一套（规格说明与实现必须同源）。
 */
export const PORTRAIT_QUALITY_STEPS = [0.9, 0.82, 0.74] as const

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
  const r = await shrinkToFit(raw, {
    fit: (w, h) => fitInside(w, h, PORTRAIT_SIZE.w, PORTRAIT_SIZE.h),
    targetBytes: PORTRAIT_TARGET_BYTES,
    qualitySteps: PORTRAIT_QUALITY_STEPS,
  })
  return { ...r, downscaled: r.quality !== PORTRAIT_QUALITY_STEPS[0] }
}

export { PORTRAIT_ACCEPT, PORTRAIT_MAX_INPUT_BYTES, PORTRAIT_SIZE, PORTRAIT_TARGET_BYTES }
