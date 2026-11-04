/**
 * 图片入库管线的公共内核（角色立绘 / 地图底图共用）。
 *
 * 两条管线只有三处不同：**怎么缩放**（fitInside 框内贴合 vs fitLongSide 长边封顶）、
 * 目标体积与质量阶梯。其余「读文件 → 解码 → 画布高质量缩放 → webp 失败换 jpeg →
 * 逐档降质量 → 返回字节数」完全一致，此前两边各抄一份，改一处容易漏另一处。
 *
 * 🔴 这里只负责把图变成可入库的 dataURL；业务侧校验文案仍由各自模块决定。
 */

/** 输入体检：类型 / 空文件 / 体积上限；`hint` 拼在超限原因末尾（各管线自己的口径） */
export function checkImageFile(
  f: { size: number; type: string },
  maxBytes: number,
  hint: string,
): { ok: boolean; reason?: string } {
  if (!f.type.startsWith('image/')) return { ok: false, reason: '请选择图片文件（PNG / JPG / WebP）' }
  if (f.size <= 0) return { ok: false, reason: '这个文件是空的，换一张试试' }
  if (f.size > maxBytes) {
    return { ok: false, reason: `原图请控制在 ${maxBytes / 1024 / 1024}MB 以内${hint}` }
  }
  return { ok: true }
}

/** 读成 dataURL（Node 单测不调用；顶层不碰 DOM） */
export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

export interface ShrinkOptions {
  /** 目标尺寸计算（保持比例、不裁切） */
  fit: (srcW: number, srcH: number) => { w: number; h: number }
  /** 体积上限（字节） */
  targetBytes: number
  /** 质量阶梯，首档为默认档 */
  qualitySteps: readonly number[]
}

export interface ShrinkResult {
  dataUrl: string
  bytes: number
  quality: number
  /** 处理后的像素尺寸 */
  w: number
  h: number
}

/**
 * 按质量阶梯导出，直到满足体积上限；最低档仍超限时返回最低档结果（**不继续压**，
 * 再压就该糊了，宁可让作者换一张小图）。
 */
export function shrinkToFit(dataUrl: string, opts: ShrinkOptions): Promise<ShrinkResult> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const srcW = img.naturalWidth || img.width
        const srcH = img.naturalHeight || img.height
        const { w, h } = opts.fit(srcW, srcH)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('画布不可用')); return }
        // 缩放时给点质量感（默认插值在大幅缩小时偏糊）
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, w, h)

        const isWebp = (s: string) => s.startsWith('data:image/webp')
        let best = { dataUrl: canvas.toDataURL('image/webp', opts.qualitySteps[0]), quality: opts.qualitySteps[0] as number }
        // 环境不支持 webp 时 toDataURL 会静默回落 png（体积大得多）→ 换 JPEG
        if (!isWebp(best.dataUrl)) {
          best = { dataUrl: canvas.toDataURL('image/jpeg', opts.qualitySteps[0]), quality: opts.qualitySteps[0] }
        }
        let bytes = dataUrlBytes(best.dataUrl)
        for (const q of opts.qualitySteps.slice(1)) {
          if (bytes <= opts.targetBytes) break
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

/** dataURL 的近似字节数（base64 膨胀约 4/3） */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',')
  if (i < 0) return 0
  const b64 = dataUrl.slice(i + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}