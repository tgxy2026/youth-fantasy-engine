/**
 * 角色立绘的**规格常量与提示文案**（2.4.1 · B7）—— 单一真源
 *
 * 🔴 为什么要单独一个文件：`imagePortrait.ts`（实现）与三张角色卡表（UI）都要用这些数字与文案。
 *    照 `imageAvatar.ts` 的 `AVATAR_HINT_SPEC` 的先例 —— **规格说明与实现必须同源**，
 *    否则作者会按一套比例去裁图、软件按另一套处理，做完才发现被改了尺寸。
 *
 * 【为什么是 512×910】
 *   ① 512 : 910 ≈ 9:16，是立绘 / 人物图的常见比例；
 *   ② 512 宽在卡片里（约 120~160px 显示宽）有 3 倍以上余量，高分屏放大也不糊；
 *   ③ 再往上（如 768×1365）单张约 300KB，30 个角色就 9MB —— 桌面整库一个 JSON，同步会明显变沉。
 */

export const PORTRAIT_SIZE = { w: 512, h: 910 } as const

/** 原图体积上限（超出直接拒绝，提示作者换小图 —— 不猜、不硬压） */
export const PORTRAIT_MAX_INPUT_BYTES = 8 * 1024 * 1024

/** 处理后的目标体积上限：超了走质量阶梯（见 imagePortrait.ts） */
export const PORTRAIT_TARGET_BYTES = 200 * 1024

export const PORTRAIT_ACCEPT = 'image/png,image/jpeg,image/webp'

/**
 * 给作者看的图片规格建议（唯一真源）。
 * ⚠️ 三张角色卡表（主要 / 次要 / NPC）**必须一字不差**地用这一份。
 */
export const PORTRAIT_HINT_SPEC =
  `推荐 9:16 竖图（如 ${PORTRAIT_SIZE.w}×${PORTRAIT_SIZE.h} 或更高）· PNG / JPG / WebP · 单张 ≤ ${PORTRAIT_MAX_INPUT_BYTES / 1024 / 1024}MB。`
  + `上传后按原比例缩放到不超过 ${PORTRAIT_SIZE.w}×${PORTRAIT_SIZE.h}，**不裁切、不拉伸**（人物不会缺胳膊少腿）；`
  + `体积优先保画质，超过 ${Math.round(PORTRAIT_TARGET_BYTES / 1024)}KB 时才逐档降低压缩质量 —— 竖图比横图更合适，横图两侧会留空。`
