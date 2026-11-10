// ============ 投稿提交后的界面处置（3.5.0）============
//
// 抽成纯函数是因为这段逻辑有两个**静默数据风险**，必须在单测里钉住：
//   ① 请求在途时用户继续输入 → 成功回执不能把新输入清掉；
//   ② 请求在途时切换账号 → 回执不能清空新账号的草稿、也不该把 A 的提交结果提示给 B。
// 组件只负责调用与渲染，判断全部在这里。

export interface SubmitSnapshot {
  accountKey: string
  title: string
  body: string
}

export type SubmitOutcome = 'ignore' | 'clear' | 'keep'

/**
 * @param snapshot 发起提交时捕获的内容与账号
 * @param current  回执到达时的输入与账号
 */
export function decideAfterSubmit(snapshot: SubmitSnapshot, current: SubmitSnapshot): SubmitOutcome {
  // 账号已经换了：这条回执属于上一个账号，界面与草稿都不该被它改动
  if (snapshot.accountKey !== current.accountKey) return 'ignore'
  // 内容一字未变：清空输入与本地草稿是安全的
  if (snapshot.title === current.title && snapshot.body === current.body) return 'clear'
  // 用户又写了新东西：保留新输入（草稿也会随之重新保存）
  return 'keep'
}