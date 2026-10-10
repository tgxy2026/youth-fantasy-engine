/**
 * 「排版」弹窗（2.4.0 · A5 编辑器自由缩进）
 *
 * 【为什么把「缩进单位」和「一键排版」放在同一个弹窗】
 * 两件事都在回答同一个问题：「这一章的版面按什么规矩排」。分两处放，作者要改缩进习惯得先找一圈；
 * 合并后工具栏只多一个入口，且**改动缩进单位后马上能在下面两个排版动作里看到效果**。
 *
 * 【为什么「一键排版」有两个动作而不是一个】
 * 旧版只有一个动作、且**总会把手写缩进压平**（每行强制两个全角空格）——
 * 那正是本次要解决的痛点。但"整篇版面严格对齐"对某些作者确实是想要的，
 * 所以旧行为没有删，降级为显式的第二个选项，并写清代价。
 *
 * 🔴 措辞纪律：绝不写「AI 会帮你调整格式」——缩进是**作者的排版主权**，
 *    AI 伴写 / 改写 / 续写一律不得增删缩进（见 `lib/indent.ts` 顶部）。
 *    这个弹窗里做的每一件事，都是**作者手动按下的动作**。
 */
import { AlignLeft, Info } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { confirmDialog, showToast } from '@/components/dialogs'
import { formatNovelText } from '@/lib/textTools'
import { INDENT_UNITS, splitIndent, type IndentUnit } from '@/lib/indent'

interface Props {
  content: string
  unit: IndentUnit
  onUnitChange: (u: IndentUnit) => void
  /** 粘贴归一开关（A5 遗留补全）：开＝多行粘贴按当前单位归一；关＝原样保留 */
  pasteNormalize: boolean
  onPasteNormalizeChange: (v: boolean) => void
  /** 段首缩进参考线（A5 遗留补全）：开＝每级缩进处画一条极淡竖线 */
  indentGuides: boolean
  onIndentGuidesChange: (v: boolean) => void
  /** 应用排版结果（由编辑器负责写回，且会走原生编辑命令以保住 Ctrl+Z） */
  onApply: (next: string) => void
  onClose: () => void
}

export default function FormatModal({ content, unit, onUnitChange, pasteNormalize, onPasteNormalizeChange, indentGuides, onIndentGuidesChange, onApply, onClose }: Props) {
  const lines = content.split(/\r?\n/)
  const paraCount = lines.filter(l => splitIndent(l).rest !== '').length
  const indentedCount = lines.filter(l => splitIndent(l).indent !== '').length
  const unitLabel = INDENT_UNITS.find(u => u.id === unit)?.label ?? ''

  const runPreserve = () => {
    const next = formatNovelText(content, { mode: 'preserve', unit })
    if (next === content) { showToast('已经是最规范的状态，无需改动', 'info'); return }
    onApply(next)
    showToast('排版完成：清理了多余空行与行尾空白，缩进原样保留')
    onClose()
  }

  const runUniform = async () => {
    if (!await confirmDialog({
      title: '统一为段首缩进',
      message:
        `把所有段落统一成段首「${unitLabel}」？\n` +
        `手写的多级缩进（对白、补充说明）会被压平成同一级，用于「全书版面严格对齐」。\n` +
        `执行后可用 Ctrl+Z 整体撤销。`,
    })) return
    const next = formatNovelText(content, { mode: 'uniform', unit })
    if (next === content) { showToast('已经是最规范的状态，无需改动', 'info'); return }
    onApply(next)
    showToast('排版完成：已统一为段首缩进')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="排版"
      icon={<AlignLeft size={15} />}
      width="lg"
      footer={<Button variant="secondary" size="md" onClick={onClose}>关闭</Button>}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-800/40 px-3.5 py-2.5">
          <Info size={13} className="mt-0.5 shrink-0 text-ink-400" />
          <p className="text-11 text-ink-400 leading-relaxed">
            缩进是<b className="text-ink-300">你自己的排版主权</b> —— AI 伴写、改写、续写都不会动它。
            下面两项只管你手动按下的排版动作。
          </p>
        </div>

        {/* ── 缩进单位 ── */}
        <section>
          <h3 className="text-12 font-medium text-ink-200 mb-1">缩进单位</h3>
          <p className="text-11 text-ink-500 mb-2 leading-relaxed">
            按 Tab 缩进一级、回车自动继承缩进、粘贴归一，用的都是这个单位。
            存在本机、不写进项目数据（换台机器重新选一次即可）。
          </p>
          <div className="flex flex-wrap gap-2">
            {INDENT_UNITS.map(u => (
              <Button
                key={u.id}
                variant="toggle"
                selected={unit === u.id}
                size="sm"
                onClick={() => onUnitChange(u.id)}
                title={u.hint}
              >
                {u.label}
              </Button>
            ))}
          </div>
          <p className="mt-1.5 text-10 text-ink-500">
            当前：{unitLabel} —— {INDENT_UNITS.find(u => u.id === unit)?.hint}
          </p>

          {/* 粘贴行为（A5 遗留补全）：默认归一；要贴代码 / 表格 / 别人的原文时可关掉 */}
          <div className="mt-3 pt-3 border-t border-ink-700">
            <h4 className="text-11 font-medium text-ink-300 mb-1.5">多行粘贴时</h4>
            <div className="flex gap-2">
              <Button variant="toggle" selected={pasteNormalize} size="sm"
                onClick={() => onPasteNormalizeChange(true)}
                title="从网页 / Word 粘进来的行首空白，按上面的单位统一">单位归一</Button>
              <Button variant="toggle" selected={!pasteNormalize} size="sm"
                onClick={() => onPasteNormalizeChange(false)}
                title="粘什么就是什么，一个字符都不动（贴代码、表格、别人的原文时用它）">原样保留</Button>
            </div>
            <p className="mt-1.5 text-10 text-ink-500">
              {pasteNormalize
                ? '多行粘贴会把行首空白统一成上面的单位（单行粘贴本来就不改）。'
                : '粘贴内容原样保留 —— 从别处带来的空格与缩进都不会被改动。'}
            </p>
          </div>

          {/* 段首缩进参考线（A5 遗留补全）：默认关 —— 纯视觉辅助，不碰正文 */}
          <div className="mt-3 pt-3 border-t border-ink-700">
            <div className="flex items-center gap-2">
              <h4 className="text-11 font-medium text-ink-300">段首缩进参考线</h4>
              <Button variant="toggle" selected={indentGuides} size="sm"
                onClick={() => onIndentGuidesChange(!indentGuides)}
                title="在每级缩进的位置画一条极淡的竖线，方便对齐多级缩进（只影响显示，不改正文）">
                {indentGuides ? '已开启' : '已关闭'}
              </Button>
            </div>
            <p className="mt-1.5 text-10 text-ink-500">
              开启后按上面的单位间距画淡竖线，用来对齐对白、补充说明这类多级缩进；纯显示辅助，正文一个字都不动。
            </p>
          </div>
        </section>

        <div className="h-px bg-ink-800" />

        {/* ── 一键排版 ── */}
        <section>
          <h3 className="text-12 font-medium text-ink-200 mb-1">一键排版</h3>
          <p className="text-11 text-ink-500 mb-2.5 leading-relaxed">
            两种都做同样三件事：去掉行尾空白、把连续空行折叠成一个、去掉首尾空行。
            当前章节共 <b className="text-ink-300">{paraCount}</b> 段，其中 <b className="text-ink-300">{indentedCount}</b> 段带缩进。
          </p>
          <div className="space-y-2">
            <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-3">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-12 text-ink-100">保留我的缩进<span className="ml-1.5 text-10 text-amber">推荐</span></span>
                <Button variant="primary" size="md" onClick={runPreserve}>执行</Button>
              </div>
              <p className="mt-1.5 text-11 text-ink-400 leading-relaxed">
                每一行原有的缩进深度原样保留，只清理空白。
                {indentedCount > 0 && <> 你现在这章有 {indentedCount} 段带缩进，选这个它们不会被压平。</>}
              </p>
            </div>
            <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-3">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-12 text-ink-100">统一为段首缩进</span>
                <Button variant="secondary" size="md" onClick={runUniform}>执行</Button>
              </div>
              <p className="mt-1.5 text-11 text-ink-400 leading-relaxed">
                把所有段落一律改成「段首 {unitLabel}」。⚠️ 手写的多级缩进会被压平 ——
                只在你想让整章版面严格对齐时用。
              </p>
            </div>
          </div>
          <p className="mt-2 text-10 text-ink-500">
            提示：两种排版都可以用 Ctrl+Z 整体撤销一次（走的是浏览器原生撤销栈）。
          </p>
        </section>
      </div>
    </Modal>
  )
}
