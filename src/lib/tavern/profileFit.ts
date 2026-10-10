/**
 * 酒馆模式 · 「我的档案」与在场阵容的匹配自检（W3-4 / 方案 §13 F4）
 *
 * 【为什么需要】§13「关系有距离感」诊断发现：当「我的档案」里的自我定位
 *   与这一场戏的实际阵容对不上时，AI 会顺着档案把用户当成一个"别人不认识的人"，
 *   于是角色之间演得跟在跟陌生人说话。典型两种：
 *     ① 档案的自我设定把自己写成「不在场 / 旁观 / 只负责推进」；
 *     ② 用户演了本场某个角色，但档案里的名字跟这个角色对不上。
 *
 * 【定位】这是一条**提醒**，不是校验 —— 作者完全可能有意留白、或故意这么写。
 *   所以**绝不阻断**新建流程，界面只把它显示成一条可忽略的提示。
 *
 * 【口径】判定全在这里，界面不许自己拼 —— 与「档案读取一律走 `activeProfileOf`」
 *   同一条纪律：判断只许有一处，否则界面与引擎各判一次必然漂移。
 *
 * 建立：2026-10-10（3.0 · 第 3 批 W3-4）
 */

/**
 * 命中「不在场 / 旁观 / 只推进」类自我定位的短语。
 * 覆盖两种常见写法：明说「我不在场」，或把自己定义成叙事工具（旁白 / 镜头 / 背景板）。
 */
const BYSTANDER_RE =
  /(不在场|不在场景|不在这个场|场外|旁观|旁白|摄像机|镜头|上帝视角|叙述者|观察者|只负责推进|负责推进|推进剧情|推动剧情|只推进|只当背景|背景板)/

export type ProfileFitKind = 'bystander' | 'unknown-name' | 'both'

export type ProfileFitWarning = {
  kind: ProfileFitKind
  /** 给作者看的一句话（界面直接显示，不要再改写） */
  text: string
}

export type ProfileFitInput = {
  /** 我的档案 · 名字 */
  name: string
  /** 我的档案 · 希望被怎么称呼 */
  address: string
  /** 我的档案 · 一句话自我设定 */
  persona: string
  /**
   * 本场全部参演角色卡的名字（含用户扮演的那个；已删卡不计，空名不计）。
   * 只用于「用户演了角色时，档案名是否就是这个角色」这一条判断。
   */
  castNames: string[]
  /**
   * 用户是否在这场里扮演了某个角色（即 `session.userCharId` 是否非空）。
   * 🔴 只在**演了角色**时才做名字比对：用户演自己时，档案名就是他本人的名字、
   *    本来就不该出现在角色卡里，此时比对必然误报（所以那条分支读这个开关）。
   */
  userActsRole: boolean
}

const norm = (s: string) => s.trim().toLowerCase()

/** 摘要 persona 用于提示文案（原样嵌进去会把提示撑成一大段） */
function brief(s: string, n = 20): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 检查「我的档案」与这一场阵容是否对得上。
 * @returns 命中则返回一条提示；一切正常返回 `null`。
 */
export function checkProfileFit(input: ProfileFitInput): ProfileFitWarning | null {
  const name = (input?.name ?? '').trim()
  const address = (input?.address ?? '').trim()
  const persona = (input?.persona ?? '').trim()
  const who = address || name
  // 空档案整段不注入（`buildUserProfileBlock` 对空档案返回空串）⇒ 谈不上「距离感」，直接放过
  if (!who && !persona) return null

  const cast = (input?.castNames ?? []).map(norm).filter(Boolean)
  const bystander = !!persona && BYSTANDER_RE.test(persona)
  // 名字对不上：只在本场确实有人、用户确实演了其中的角色、且档案里报了名字时才判
  const unknownName = !!input?.userActsRole && !!who && cast.length > 0 && !cast.includes(norm(who))

  if (bystander && unknownName) {
    return {
      kind: 'both',
      text: `「我的档案」把自己写成了「${brief(persona)}」这类旁观/推进定位，名字「${who}」又跟本场角色对不上 —— AI 很可能认不出你是谁，这场容易演成陌生人。`,
    }
  }
  if (bystander) {
    return {
      kind: 'bystander',
      text: `「我的档案」的自我设定写的是「${brief(persona)}」这类旁观/推进定位 —— 想让 AI 把你当在场的人，建议改成你在这场里的身份。`,
    }
  }
  if (unknownName) {
    return {
      kind: 'unknown-name',
      text: `你在这场里演的是本场角色，但「我的档案」上的名字是「${who}」、与这个角色对不上 —— AI 可能不知道你是谁。`,
    }
  }
  return null
}
