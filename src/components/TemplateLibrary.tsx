import { useState } from 'react'
import { saveCardRecord, getCurrentProjectId } from '../lib/db'
import { uid } from '../lib/id'
import { Layers, Plus } from 'lucide-react'
import { confirmDialog, showToast } from './dialogs'
import { Modal } from './Modal'

interface Props {
  tabId: string
  isVolume: boolean
  onApplied: () => void
  onClose: () => void
}

interface TplItem { name: string; note: string }
interface Template { id: string; name: string; desc: string; kind: 'volume' | 'chapter'; items: TplItem[] }

const NAME_KEY = (isVolume: boolean) =>
  isVolume ? '一、本卷定位::卷名' : '一、本章定位::章节号/标题'

const TEMPLATES: Template[] = [
  {
    id: 'golden3', name: '黄金三章法', kind: 'chapter',
    desc: '开篇三章定生死：钩子、冲突、首个小高潮，快速立住人设与悬念。',
    items: [
      { name: '第1章', note: '强钩子开场：异常事件/危机/悬念，3 段内抓住读者，亮出主角与核心矛盾。' },
      { name: '第2章', note: '冲突升级：敌人/阻碍登场，主角被迫行动，埋下第一个伏笔。' },
      { name: '第3章', note: '首个小高潮：一次胜败分明的交锋，给出继续读的承诺（金手指/身世/逆袭伏笔）。' },
    ],
  },
  {
    id: 'qicheng', name: '起承转合四幕', kind: 'chapter',
    desc: '传统章法：起势、承接、转折、合拢，适合单元剧式推进。',
    items: [
      { name: '起·开篇', note: '铺设定、立主角、抛核心事件。' },
      { name: '承·发展', note: '矛盾展开，配角与势力入场，节奏渐紧。' },
      { name: '转·高潮', note: '重大转折/危机爆发，主角面临最艰难抉择。' },
      { name: '合·收束', note: '事件落定，留下更大悬念或进入下一单元。' },
    ],
  },
  {
    id: 'threemove', name: '三幕式结构（12 章）', kind: 'chapter',
    desc: '经典商业长篇骨架：建置—对抗—结局，每幕约 1/4、1/2、1/4 篇幅。',
    items: [
      { name: '第1章 · 建置', note: '寻常世界与主角缺陷。' },
      { name: '第2章', note: '引出主线悬念。' },
      { name: '第3章 · 触发', note: '激励事件，主角被迫离巢。' },
      { name: '第4章', note: '新世界规则与对手亮相。' },
      { name: '第5章', note: '第一个小目标达成。' },
      { name: '第6章', note: '中段起点，赌注升级。' },
      { name: '第7章', note: '盟友与资源集结。' },
      { name: '第8章', note: '伪胜利/短暂平静。' },
      { name: '第9章 · 中点转折', note: '计划崩坏，局势急转。' },
      { name: '第10章', note: '至暗时刻前奏。' },
      { name: '第11章 · 高潮', note: '主角蜕变，正面决战。' },
      { name: '第12章 · 结局', note: '代价与新生，新平衡建立。' },
    ],
  },
  {
    id: 'hero', name: '英雄之旅（12 节拍）', kind: 'chapter',
    desc: '坎贝尔神话结构，适合成长型主角的大长篇。',
    items: [
      { name: '第1章 · 平凡世界', note: '主角日常与缺失。' },
      { name: '第2章 · 召唤', note: '冒险的邀约出现。' },
      { name: '第3章 · 拒斥', note: '犹豫与阻力。' },
      { name: '第4章 · 导师', note: '引路人给予道具/教诲。' },
      { name: '第5章 · 跨越', note: '越过第一道门槛。' },
      { name: '第6章 · 试炼', note: '盟友、敌人与初步考验。' },
      { name: '第7章 · 深渊', note: '最大恐惧直面。' },
      { name: '第8章 · 报酬', note: '获得关键宝物/真相。' },
      { name: '第9章 · 回归路', note: '携成果踏上归途。' },
      { name: '第10章 · 复活', note: '终极考验，旧我消亡。' },
      { name: '第11章 · 归来', note: '以蜕变之姿回到世界。' },
      { name: '第12章 · Master', note: '两界贯通，成为新秩序的主人。' },
    ],
  },
  {
    id: 'volume3', name: '三卷架构（卷纲）', kind: 'volume',
    desc: '长篇小说常见三卷：蓄势—裂变—终局，适合在「分卷大纲」套用。',
    items: [
      { name: '第一卷 · 风起', note: '建置世界观与主角，埋主线伏笔，节奏由缓入紧。' },
      { name: '第二卷 · 云涌', note: '矛盾全面爆发，多方势力博弈，主角实力与格局跃升。' },
      { name: '第三卷 · 潮落', note: '收束所有伏笔，终极对决与代价，建立新秩序。' },
    ],
  },
]

export default function TemplateLibrary({ tabId, isVolume, onApplied, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const list = TEMPLATES.filter(t => t.kind === (isVolume ? 'volume' : 'chapter'))

  const apply = async (tpl: Template) => {
    if (busy) return
    if (!await confirmDialog({ title: '套用模板', message: `将「${tpl.name}」的 ${tpl.items.length} 个${isVolume ? '卷' : '章'}大纲插入到当前${isVolume ? '分卷' : '章节'}大纲？\n（不影响已有内容，可随后改名/删除）` })) return
    setBusy(true)
    try {
      const pid = getCurrentProjectId()
      const nameKey = NAME_KEY(isVolume)
      const orderBase = Date.now()
      await Promise.all(tpl.items.map((it, i) =>
        saveCardRecord({
          id: uid(), projectId: pid, tabId,
          name: it.name,
          data: { [nameKey]: it.name, [`二、核心目标::本单元核心目标`]: it.note },
          order: orderBase + i,
        })
      ))
      onApplied()
      onClose()
    } catch (e) {
      showToast('套用模板失败：' + ((e as Error)?.message || String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="结构模板库"
      icon={<Layers size={16} />}
      width={672}
      headerExtra={<span className="text-[11px] text-ink-500">套用到「{isVolume ? '分卷大纲' : '章节细纲'}」</span>}
    >
      <div className="space-y-3">
          {list.map(tpl => (
            <div key={tpl.id} className="rounded-xl border border-ink-700 bg-ink-850 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-ink-100">{tpl.name}</div>
                  <div className="text-[11px] text-ink-400 mt-1 leading-relaxed">{tpl.desc}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => apply(tpl)}
                  className="shrink-0 flex items-center gap-1 px-3 py-1.5 bg-amber/15 text-amber border border-amber/30 rounded-lg text-[12px] font-medium hover:bg-amber/25 disabled:opacity-50"
                >
                  <Plus size={12} /> 套用（{tpl.items.length}）
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {tpl.items.map((it, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-ink-800 border border-ink-700 text-ink-300">{it.name}</span>
                ))}
              </div>
            </div>
          ))}
          {list.length === 0 && (
            <div className="text-center text-ink-500 text-[12px] py-8">当前大纲类型暂无可套用模板。</div>
          )}
        </div>
    </Modal>
  )
}
