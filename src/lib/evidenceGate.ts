/**
 * 3.0 · W1-2b 缺失即停 —— 生成前的「必需证据」检查（§10.3 #2）
 *
 * 🔴 为什么要它（把一句注释变成硬约束）：
 *    `getContinuationSources` 的注释一直写着「焦点章必须在叙事序里找得到，否则 found:false
 *    —— 调用方要据此提示作者，**而不是当没有素材硬发**（那会让模型凭空编）」。
 *    但此前调用方只是**提示一句就照发** —— 模型拿着空上下文硬写，作者还以为是模型水平问题。
 *    本模块把那句话落成**可调用的判据**：缺 ⇒ 调用方**停止生成**并给可行动作。
 *
 * 口径（与 §10.3 #2 一致）：
 *   · 只判**必需**证据（缺了就写不出来 / 写飞），不判「锦上添花」的可选素材；
 *   · 缺 ⇒ **停 + 如实说明 + 给下一步**，**不自动改用别的素材硬凑**、不自动重试。
 */

/** 证据缺口的分类（供调用方与日志区分场景） */
export type EvidenceCode =
  | 'continuation-focus'   // 续写：定位不到焦点章
  | 'rewrite-target'       // 整章改写：目标章没有正文
  | 'audit-chapters'       // 一致性审计：有正文的章太少

export interface EvidenceGap {
  code: EvidenceCode
  /** 讲清「缺了什么、为什么会出问题」 */
  message: string
  /** 可行动作（作者下一步能做什么） */
  action: string
}

/** 拼成一句给作者看的话 */
export function formatGap(g: EvidenceGap): string {
  return `${g.message}${g.action}`
}

/**
 * 续写：焦点章必须能在叙事序里定位到 —— 续写要以「本章结尾」为衔接点，
 * 定位不到就没有衔接点，模型只能凭空编（实测会写成另一个场景）。
 */
export function checkContinuationFocus(found: boolean): EvidenceGap | null {
  if (found) return null
  return {
    code: 'continuation-focus',
    message: '没能在章节列表里定位到本章 —— 续写要以「本章结尾」为衔接点，缺了它会写飞。',
    action: '请先刷新章节列表、确认本章还在项目里，再试一次。',
  }
}

/**
 * 整章改写：目标章必须**有正文**才谈得上改写。
 * （既有代码已有这个守卫；收到这里是为了让「必需证据」只有一处口径。）
 */
export function checkRewriteTarget(hasBody: boolean): EvidenceGap | null {
  if (hasBody) return null
  return {
    code: 'rewrite-target',
    message: '这一章还没有正文，没什么可改的。',
    action: '先在这一章写点内容，或换一章再试。',
  }
}

/**
 * 一致性审计：至少要两章有正文 —— 单章无从「跨章核对」。
 * 📌 预留（2026-10-10 轻量审计标注）：随 W2-2「一致性审计」接线 —— 它是「必需证据」三件套里
 *    唯一还没落到生产路径的一条（另两条已用于续写 / 改写）。已有单测钉住，不是死代码。
 */
export function checkAuditChapters(writtenChapters: number): EvidenceGap | null {
  const n = Number.isFinite(writtenChapters) && writtenChapters > 0 ? writtenChapters : 0
  if (n >= 2) return null
  return {
    code: 'audit-chapters',
    message: `目前只有 ${n} 章有正文 —— 一致性审计要跨章核对，单章无从比对。`,
    action: '至少写完两章再来审计。',
  }
}
