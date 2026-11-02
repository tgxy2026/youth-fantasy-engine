// ============ 手册内容 · 数据与界面（主题与密度） ============
//
// 事实来源（2026-11-02 人工核对）：`lib/settings/theme.ts` 的 THEMES 九项 + custom、
// `components/settings/DensityControl.tsx` 的「紧凑 / 舒适」、`Sidebar` 的 AppearanceToggles（背景 / 全屏）。
// 🔴 全屏在 3.3.4 · C2 起不再只对桌面开放：桌面走窗口桥（F11/ESC），网页/便携走浏览器 Fullscreen API
//    （Esc 退出、可能被权限策略拒绝）。这类差异必须写出来，不能让网页版作者白找。
import type { HelpArticle } from '@/lib/help/types'

export const LOOK_ARTICLES: HelpArticle[] = [
  {
    id: 'look-theme-density',
    revision: 2,
    title: '主题、密度与背景：界面长什么样',
    summary: '九种预制主题加自定义，密度只两档；这三项只管显示，不动正文一个字。',
    aliases: ['换肤', '配色', '深色模式', '护眼', '界面密度', '背景图'],
    keywords: ['主题', '配色', '深色', '浅色', '护眼', '纯黑白', '密度', '紧凑', '舒适', '背景', '全屏'],
    group: '数据与界面',
    tabIds: ['dashboard'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'theme',
        heading: '主题：九种预制 + 自定义',
        body: [
          '左下角外观区的主题栏里点色块即可换：暗夜、护眼（默认）、午夜蓝、羊皮卷、暮山紫、青花、松烟墨、桃笺、纯黑白。',
          '最后一个是「自定义」：以某个母版派生，可以自己调色；它与其他主题一样只影响显示，不改任何数据。',
          '主题与界面缩放互相独立，换主题不会改你设好的缩放比例。',
        ],
      },
      {
        id: 'density',
        heading: '界面密度：紧凑 / 舒适',
        body: [
          '密度只有两档：紧凑让控件与面板更紧，一屏能放更多；舒适留出更多呼吸感。',
          '它只影响界面排布，不改正文字号与段落设置 —— 正文字号在正文右下角单独调（14–28px）。',
        ],
      },
      {
        id: 'background-fullscreen',
        heading: '背景图案与全屏',
        body: [
          '背景：界面底层的金色书本与房子线条图案，可以关掉只留主题底色（工作区、项目管理首页、新手向导三处一起生效），设置跨启动记忆。',
          '全屏：左下角「外观」里的全屏开关。桌面版进入无边框全屏，再按 F11 或 ESC 退出；网页版 / 便携版走浏览器自带的 Fullscreen API（按 Esc 或再点一次退出），能否进入取决于本页权限与浏览器策略 —— 被拒绝会给出提示；环境不支持全屏时，开关不显示，请用编辑器的「专注模式」（它不隐藏地址栏，也不等于全屏）。',
        ],
      },
    ],
    related: ['faq-zoom'],
    verifiedAgainst: '3.3.4',
    reviewedAt: '2026-11-02',
  },
]
