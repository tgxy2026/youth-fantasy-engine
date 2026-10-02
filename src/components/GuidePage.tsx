import { BookOpen, Lightbulb, ListOrdered } from 'lucide-react'
import { TABS, EDITOR_TAB, EDITOR_ID, tabVisible, type VisCtx } from '../lib/schema'
import HelpPopover from './HelpPopover'
import { Button } from './Button'

interface Props {
  onNavigate: (id: string) => void
  /** 项目形态：精简/极简项目隐藏对应标记的页签 */
  ctx: VisCtx
}

const FILL_ORDER = [
  'positioning', 'worldbase', 'power', 'char-main', 'char-secondary',
  'history', 'master', 'volume-outline', 'chapter-master', 'chapter-outline'
]

// 全部功能页签按分类分组的展示顺序（对应"从零开书"的递进流程）
// 末尾两项是工具 / 玩法类：正文写作是码字现场，酒馆模式是可选的角色扮演玩法。
// ⚠️ 本清单必须与 schema.ts 的 GROUPS 保持覆盖一致 —— 漏一个组，整组页签就从这一页消失
//    （曾因此漏掉整个酒馆模式：页签、说明、跳转全都没有）。
const GROUP_ORDER = [
  '开书定位', '大纲规划', '角色管理', '世界构建', '创作管理', '运营维护', '灵感工具', '正文写作', '酒馆模式'
]

/** 正文编辑不在 TABS 里（是 EDITOR_TAB 常量），故在列表里单独成条 */
const EDITOR_DESC = '真正码字的地方：左侧带设定检索栏，可边写边查。'

const TIPS: { title: string; body: string }[] = [
  { title: '先定位再动笔', body: '开书前先填作品信息：赛道、平台、读者、卖点没想清楚就动笔，多半会切书。' },
  { title: '全书总纲先行', body: '动笔前总纲必填：主线一句话、大结局、分卷规划一览；每卷结束回看修订一次。' },
  { title: '世界观三层填法', body: '底层法则（定了不改）→社会文明（前十章展开）→细节（随写随补）。世界观是舞台不是字典。' },
  { title: '等级表是宪法', body: '力量体系的等级一旦正文发布尽量不改；定稿前先写三章试水，检验数值是否膨胀。' },
  { title: '角色三档分级', body: '主要角色=核心；次要角色=阶段性宿敌/导师/配角；NPC=功能型。戏份变了及时升降级。' },
  { title: '问答法深挖动机', body: '对着角色卡连问三个「为什么」，问到第三个为什么，动机才立得住。' },
  { title: '随写随登记', body: '正文里每写出一个新设定立刻回表登记，连载百万字后你会感谢这套表。' },
  { title: '伏笔与前置条件', body: '伏笔登记时同步写清「回收前读者需要知道什么」——前置没铺就强行回收，效果大打折扣。' },
  { title: '每章结尾必有钩子', body: '网文和传统文学最大的区别；连载形态下章末平淡=流失读者。' },
  { title: '改设定先过设定变更', body: '连载中要改设定，先登记旧值新值、影响范围、已发布冲突——冲突未处理前不发布后续章节。' },
  { title: '知情权限随时登记', body: '读者对「谁知道什么」记得比你牢；每当有角色知悉秘密当天登记，防泄密穿帮。' },
  { title: '灵感即时入库', body: '灵感出现的当天就登记；写细纲卡壳先翻素材库再硬编。' },
]

export default function GuidePage({ onNavigate, ctx }: Props) {
  return (
    <div className="w-full page-enter">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">使用指南</h1>
          <HelpPopover title="使用指南怎么看" width="22rem" size={14}>
            {'这一页是全软件的地图，卡壳时先回这里。\n\n· 推荐填写顺序：按 1→10 的顺序点进去填，是一套经过验证的开书流程，点任意按钮可直达该页签；\n· 全部功能页签：所有页签的一句话说明，点标题直接跳转；\n· 核心创作方法论：12 条网文实操心法，动笔前后各看一遍。\n\n任意功能标题旁的 ? 图标都能点开该功能的详细用法说明。'}
          </HelpPopover>
        </div>
      </header>

      {/* 推荐填写顺序 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <ListOrdered size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">推荐填写顺序</h2>
          <HelpPopover title="推荐填写顺序" width="21rem">
            {'这是「从零开书」的标准路径：\n\n1-3 先定位与世界底层（赛道/读者/卖点、世界法则、力量体系）；\n4-5 立住主角与核心配角；\n6 用倒推法把历史事件从结局倒推回开篇；\n7-8 写全书总纲与分卷规划；\n9-10 落到章节总表与章节细纲，然后就可以动笔了。\n\n不必一次填满：每卷开写前补一轮，写完一卷回看修订一轮。'}
          </HelpPopover>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {FILL_ORDER.map((id, i) => {
              const tab = TABS.find(t => t.id === id)
              if (!tab || !tabVisible(tab.id, ctx)) return null
              return (
                <div key={id} className="flex items-center gap-1.5">
                  <Button variant="secondary" onClick={() => onNavigate(id)} className="px-3 py-1.5 rounded-lg text-12 hover:border-amber/50 hover:text-amber transition-colors">
                    {i + 1}. {tab.name}
                  </Button>
                  {i < FILL_ORDER.length - 1 && <span className="text-ink-600 text-10">→</span>}
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-11 text-ink-400">历史事件用倒推法（从大结局倒推到开篇）；写作期间持续维护伏笔、时间脉络与设定变更。</p>
        </div>
      </section>

      {/* 全部页签 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <BookOpen size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">全部功能页签</h2>
          <HelpPopover title="全部功能页签" width="21rem">
            {'软件里每个页签的职责一览，点任意条目直接跳转。\n\n· 表单型页签（作品信息、世界设定、全书总纲…）：一栏一栏填，Ctrl+S 保存；\n· 表格型页签（伏笔、时间脉络、爽点、设定变更…）：一行一条记录，随写随登记；\n· 卡片型页签（角色卡、分卷大纲、章节细纲）：一张卡一个对象，左侧目录切换；\n· 正文编辑：真正码字的地方，左侧带设定检索栏可边写边查；\n· 颉文姬 · AI 编辑：右下角的 Q 版精灵（或编辑器工具栏魔杖图标）——诊室（校对·文字层 / 校对·逻辑层 / 综合诊断）、编辑（选区润色改稿）、审读（六维打分 / OOC / 续写方向 / 爽点毒点 / 黄金三章）、简报（开写前的本章写作简报）、补登（抽出本章新设定，一键登记进设定表或角色卡），未配置模型时本地功能照常。\n· 自定义项目：本页列出全部页签，未启用的功能以灰色显示且不可跳转；要启用请回到项目管理页编辑项目功能清单。'}
          </HelpPopover>
        </div>
        <div className="p-5 space-y-6">
          {GROUP_ORDER
            .map(g => ({
              group: g,
              items: g === '正文写作'
                ? [{ id: EDITOR_ID, name: EDITOR_TAB.name, description: EDITOR_DESC }]
                : TABS.filter(t => t.type !== 'dashboard' && t.type !== 'guide' && t.group === g),
            }))
            .filter(g => g.items.length > 0)
            .map(({ group, items }) => (
              <div key={group}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className="w-1 h-3 rounded-full bg-amber/70" />
                  <span className="text-12 font-semibold text-ink-200">{group}</span>
                  <span className="text-10 text-ink-600">{items.length} 项</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-x-6 gap-y-1">
                  {items.map(item => {
                    const enabled = tabVisible(item.id, ctx)
                    return (
                      <Button variant="bare"
                        key={item.id}
                        disabled={!enabled}
                        onClick={() => enabled && onNavigate(item.id)}
                        className={`group flex-col items-stretch w-full text-left py-2 border-b border-ink-700/50 transition-colors ${enabled ? 'hover:border-amber/30 cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`flex-1 min-w-0 text-13 font-medium transition-colors ${enabled ? 'text-ink-100 group-hover:text-amber' : 'text-ink-500'}`}>{item.name}</span>
                          {!enabled && <span className="shrink-0 text-9 px-1 py-0.5 rounded bg-ink-700 text-ink-400">未启用</span>}
                        </div>
                        <div className={`text-11 mt-0.5 line-clamp-1 ${enabled ? 'text-ink-400' : 'text-ink-600'}`}>{item.description}</div>
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
        </div>
      </section>

      {/* 使用建议 */}
      <section className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Lightbulb size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">核心创作方法论</h2>
          <HelpPopover title="核心创作方法论" width="21rem">
            {'12 条从网文实战里提炼的规则，对应软件里的具体动作：\n\n· 开书前：先定位 → 再总纲 → 再世界观三层填法；\n· 连载中：随写随登记（新设定当天回表）、每章结尾留钩子、伏笔写清前置条件；\n· 改设定：必须先过「设定变更」，冲突未处理前不要发布后续章节。\n\n卡文时优先翻「灵感素材」而不是硬编。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
