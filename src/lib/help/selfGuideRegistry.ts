// ============ 「本页指引」自托管页面注册表 ============
//
// 背景：引导有两种托管方式 ——
//   · App 层托管（`usePageGuideHost`）：页签数据一进来就能开始，侧栏「本页指引」按钮直接调用它；
//   · 页面自托管（`SELF_MANAGED_GUIDE_TABS`：开书定位 / 正文编辑 / 伏笔追踪）：要等页面自己的数据就绪，
//     由页面内的 `usePageGuide` 管，历史上只在页头放了一个按钮。
//
// 🔴 2026-11-15（作者反馈）：正文编辑页出现自相矛盾 —— 工具栏有「本页指引」可用，
//   而左下角同一个入口却显示「此页无」。原因是侧栏只看 App 层托管。
//   这里给自托管页面开一个注册口：页面把自己的 `start` 登记进来，侧栏据此判断「这一页其实有指引」，
//   于是两个入口统一走左下角，页头那个重复按钮被撤掉。
//
// 约束：注册表只存函数引用，不碰任何项目数据；页面卸载即注销，避免指向已卸载组件的旧闭包。

type Starter = () => void

const starters = new Map<string, Starter>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

/** 页面挂载后登记自己的引导启动函数；返回注销函数（在 effect cleanup 里调用）。 */
export function registerSelfGuide(tabId: string, start: Starter): () => void {
  starters.set(tabId, start)
  notify()
  return () => {
    if (starters.get(tabId) === start) {
      starters.delete(tabId)
      notify()
    }
  }
}

/** 该页签是否由页面自己提供引导（供侧栏决定按钮是否可用）。 */
export function hasSelfGuide(tabId: string): boolean {
  return starters.has(tabId)
}

/** 触发自托管页面的引导；没有登记时返回 false，由调用方决定怎么提示。 */
export function startSelfGuide(tabId: string): boolean {
  const start = starters.get(tabId)
  if (!start) return false
  start()
  return true
}

/** 订阅登记表变化（侧栏按钮要随页面挂载 / 卸载即时变可用）。 */
export function subscribeSelfGuides(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
