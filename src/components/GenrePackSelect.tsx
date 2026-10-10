/**
 * 「作品题材」选择控件（2.7.1 建，2.7.2 收敛为**只在新建项目时**用）。
 *
 * 🔴 2.7.2 主人定案：题材改在**新建小说项目时**选定，进来之后**页签里不再提供切换**。
 *   · 新建项目表单（`ProjectHub`）与首启向导（`WelcomeWizard`）用这里的**纯受控下拉** ——
 *     此时还没有项目，只取值，不落库（题材在 `createProject` 时写进 `Project.genre`）。
 *   · 原先还有一个「带落库与联动」的 `GenrePackSwitcher` 挂在《世界设定》页头部
 *     （让老项目事后改题材），现已**整体移除** —— 页签里再放一个能改题材的控件，
 *     等于和项目记录两个真相源，迟早会打架。改题材请回项目管理页「编辑项目」。
 *
 * ## 题材现在只影响什么（2.7.2 明确收窄）
 * ① 各页签里的**字段名、说明文字与示例**随题材变（`modulesFor(tabId, pack)`）；
 * ② **不再决定「有没有这一页」** —— 完整项目全部页签开箱即用，
 *    自定义项目按建项目时勾选的「功能模块」显示。
 */
import { GENRE_PACKS, type GenrePack } from '@/lib/schemaTemplates/index'

const SELECT_CLS =
  'bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-2.5 py-1.5 outline-none focus:border-amber/40'

/**
 * 作品题材下拉（**纯受控**：只取值，落库由调用方在建项目时负责）。
 *
 * 用在：新建项目表单、首启向导。
 */
export function GenrePackSelect({
  value, onChange, className = '',
}: {
  value: GenrePack
  onChange: (pack: GenrePack) => void
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as GenrePack)}
      className={`${SELECT_CLS} ${className}`}
      title="选择作品题材：决定《开书定位》各页签里的字段名与填写说明随哪一套走；不影响页签数量。"
    >
      {GENRE_PACKS.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  )
}
