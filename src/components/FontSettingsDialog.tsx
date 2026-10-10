/**
 * 字体设置弹窗（2026-09-28 · 社区需求）—— 正文编辑器 + 界面全站两个口。
 *
 * 🔴 预览与生效分离（C1 自定义主题同款）：
 *    · 改动 → applyFontPrefs 即时预览（写 / 移除 CSS 变量，tailwind 栈首 var() 跟随）；
 *    · 「应用」→ storeFontPrefs 落 localStorage（yfe-font-prefs，应用级偏好跟人不跟项目）；
 *    · 取消 / Esc / 遮罩关闭 → applyFontPrefs(快照) 回滚到打开前状态。
 *
 * 系统字体枚举仅桌面版可用（main.cjs 已放行 local-fonts 权限）；浏览器 / 便携版
 * listSystemFonts 返回 null → 降级为「预置清单 + 自定义输入」，功能不缺只是少了枚举。
 *
 * 🔴 盒模型红线：正文四图层共享 .novel-textarea 类，字体走类级继承自动一致 ——
 *    本弹窗只写全局 CSS 变量，**绝不碰任何组件的内联样式**。
 */
import { useEffect, useState } from 'react'
import { Type } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import HelpPopover from '@/components/HelpPopover'
import { showToast } from '@/components/dialogs'
import { DESKTOP } from '@/lib/desktop'
import {
  PRESET_FONTS, getStoredFontPrefs, applyFontPrefs, storeFontPrefs,
  listSystemFonts, sanitizeFontStack, fontStackLabel,
  type FontPrefs,
} from '@/lib/fontPrefs'

/** 系统字体枚举缓存：缓存的是 **Promise 本身**（并发重开弹窗不会重复发起全量枚举） */
let systemFontsCache: Promise<string[] | null> | undefined
/** 系统字体下拉的渲染上限（字体管理器用户可能装几千字族，全量塞 select 会卡） */
const MAX_SYSTEM_FONT_OPTIONS = 500

/** 当前值落在哪个选项上（select 的受控 value） */
function matchOption(stack: string, systemFonts: string[] | null): string {
  if (!stack) return 'default'
  const preset = PRESET_FONTS.find(p => p.stack === stack)
  if (preset) return `preset:${preset.name}`
  if (systemFonts?.includes(fontStackLabel(stack))) return `sys:${fontStackLabel(stack)}`
  return 'custom'
}

interface Props {
  open: boolean
  /** 关闭（取消）：弹窗内部已回滚；应用后同样走这里（父组件无需感知——字体不影响 React 状态） */
  onClose: () => void
}

/** 单个字体口的选择区（正文 / 界面共用一套结构） */
function FontSlot(props: {
  title: string
  help: string
  value: string
  systemFonts: string[] | null
  onChange: (stack: string) => void
  previewText: string
}) {
  const { title, help, value, systemFonts, onChange, previewText } = props
  const option = matchOption(value, systemFonts)
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-13 text-ink-200">{title}</span>
        <HelpPopover title={`${title}怎么用`} width="20rem" size={11}>
          {help}
        </HelpPopover>
      </div>
      <select
        value={option}
        onChange={e => {
          const v = e.target.value
          if (v === 'default') onChange('')
          else if (v.startsWith('preset:')) onChange(PRESET_FONTS.find(p => `preset:${p.name}` === v)?.stack ?? '')
          else if (v.startsWith('sys:')) onChange(`"${v.slice(4)}"`)
          // 选「自定义」：值已在输入框里，不改动
        }}
        className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-13 text-ink-200 outline-none focus:border-amber"
        aria-label={title}
      >
        <option value="default">跟随默认</option>
        <optgroup label="常用字体">
          {PRESET_FONTS.map(p => (
            <option key={p.name} value={`preset:${p.name}`}>{p.name}</option>
          ))}
        </optgroup>
        {systemFonts && systemFonts.length > 0 && (
          <optgroup label={systemFonts.length > MAX_SYSTEM_FONT_OPTIONS
            ? `系统字体（本机共 ${systemFonts.length} 项，仅列前 ${MAX_SYSTEM_FONT_OPTIONS} 项，其余请用自定义输入直接填名称）`
            : '系统字体（本机全部）'}>
            {systemFonts.slice(0, MAX_SYSTEM_FONT_OPTIONS).map(f => (
              <option key={f} value={`sys:${f}`}>{f}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="高级">
          <option value="custom">自定义字体名…</option>
        </optgroup>
      </select>
      {/* 自定义输入：选了预置 / 系统字体后会回填对应的字体栈段，手改即成「自定义」。
          🔴 输入经 sanitizeFontStack 清洗 —— 分号 / 大括号等声明截断字符会被剥掉（CSS 注入面）。 */}
      <input
        type="text"
        value={value}
        onChange={e => onChange(sanitizeFontStack(e.target.value))}
        placeholder="自定义字体名（留空 = 跟随默认），如：楷体、霞鹜文楷"
        className="mt-1.5 w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-12 text-ink-200 outline-none focus:border-amber"
        aria-label={`${title}自定义输入`}
      />
      {/* 预览行：用该口当前值渲染示例文字，用户不用猜「选了之后长什么样」 */}
      <div className="mt-1.5 rounded border border-ink-700 bg-ink-900/50 px-2.5 py-2">
        <span className="text-13" style={{ fontFamily: value || undefined }}>{previewText}</span>
        <span className="ml-2 text-11 text-ink-400">
          {value ? `当前：${fontStackLabel(value) || value}` : '当前：跟随默认'}
        </span>
      </div>
    </div>
  )
}

export default function FontSettingsDialog({ open, onClose }: Props) {
  const [draft, setDraft] = useState<FontPrefs>({ editor: '', ui: '' })
  /** 打开时的快照：取消 / Esc 回滚依据（预览会即时改全局变量，不能靠重读存储） */
  const [saved, setSaved] = useState<FontPrefs | null>(null)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)

  useEffect(() => {
    if (!open) return
    const snap = getStoredFontPrefs()
    setSaved(snap)
    setDraft(snap)
    if (systemFontsCache === undefined) {
      // 便携版走同一份 dist 但无窗口桥 → DESKTOP 为 false，不白发一次必被拒的请求
      systemFontsCache = DESKTOP ? listSystemFonts() : Promise.resolve(null)
    }
    void systemFontsCache.then(r => setSystemFonts(r))
  }, [open])

  /** 即时预览（弹窗开着才有效果，关闭时由回滚兜底） */
  const patch = (p: Partial<FontPrefs>) => {
    const next = { ...draft, ...p }
    setDraft(next)
    applyFontPrefs(next)
  }

  const handleApply = () => {
    const storedOk = storeFontPrefs(draft)
    applyFontPrefs(draft)   // 已在预览中生效，这里幂等
    if (!storedOk) {
      // 写盘失败必须说出来：本次会话预览仍生效，但重启后不会恢复（隐私模式 / 配额满）
      showToast('字体偏好未能保存到本机（存储不可写），本次会话内仍然生效', 'info')
    }
    onClose()
  }

  const handleClose = () => {
    if (saved) applyFontPrefs(saved)   // 回滚到打开前状态
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="字体设置"
      icon={<Type size={15} />}
      width="md"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="secondary" size="sm" onClick={() => patch({ editor: '', ui: '' })}
            title="两个口都回到软件默认字体（思源宋体正文 / 思源黑体界面）">
            全部恢复默认
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>取消</Button>
            <Button variant="primary" size="sm" onClick={handleApply}>应用</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <FontSlot
          title="正文编辑器字体"
          help={'写作区（章节正文）使用的字体。\n\n· 「跟随默认」= 思源宋体；选了未安装的字体时自动回落到默认，不会白屏；\n· 桌面版可以从「系统字体」里列出本机全部字体；\n· 改动实时预览，满意点「应用」保存，未应用关闭会自动还原。'}
          value={draft.editor}
          systemFonts={systemFonts}
          onChange={s => patch({ editor: s })}
          previewText="永和九年，岁在癸丑。他望向山外，0123 ABC abc"
        />
        <FontSlot
          title="界面字体"
          help={'软件界面（菜单、表格、按钮等）使用的字体，与正文相互独立。\n\n· 建议界面用黑体系、正文用宋体 / 楷体系，层次更分明；\n· 同样支持系统字体枚举与自定义输入；\n· 设置保存在本机，跨项目、下次打开沿用。'}
          value={draft.ui}
          systemFonts={systemFonts}
          onChange={s => patch({ ui: s })}
          previewText="界面预览：章节总表 世界设定 0123 ABC abc"
        />
        <div className="rounded border border-ink-700 bg-ink-900/50 px-3 py-2 text-11 text-ink-400 leading-relaxed">
          改动会实时预览：满意点「应用」保存，未应用直接关闭会自动还原到打开前的字体。
          字体设置保存在本机、跟人走，所有项目共用一套。
        </div>
      </div>
    </Modal>
  )
}
