/**
 * 酒馆模式 · 扮演设定编辑（方案 §6.4）
 *
 * 【它和角色卡的分工】
 * 角色卡回答「她是谁」（设定档）；扮演设定回答「该怎么演她」（行为指令）。
 * 所以六个字段写的都是**行为倾向**，不是背景资料 —— 界面上也这么提示作者，
 * 免得把角色卡的内容再抄一遍：那样既占上下文，又和卡片打架。
 *
 * 【入口】剧情推演页左栏「角色分配」里，每个 user / ai 角色旁一个按钮；
 * 存 `tavern.cast.<cardId>`，属项目级 settingsKV（随项目走、导出自动带走）。
 */
import { useEffect, useState } from 'react'
import * as store from '../lib/tavern/store'
import { EMPTY_CAST_SETTING, type CastSetting } from '../lib/tavern/types'
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast } from './dialogs'

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50 resize-none'

/** 六字段的界面文案（标题 / 说明 / 占位示例）——顺序即渲染顺序，与 prompt.ts 的 CAST_FIELDS 一致 */
const FIELDS: { key: keyof CastSetting; label: string; hint: string; ph: string }[] = [
  {
    key: 'voice', label: '口吻', hint: '她怎么说话：句子长短、口头禅、爱不爱反问',
    ph: '例：话少，句子短，不用感叹号。被逼急了才一次说长句。',
  },
  {
    key: 'address', label: '称呼你的方式', hint: '她管你叫什么（不同亲疏时可分开写）',
    ph: '例：平常叫「老板」，认真时改口叫全名。',
  },
  {
    key: 'unknown', label: '知识边界', hint: '哪些事她不知道（写了它就不会「恰好知道」）',
    ph: '例：不知道你修炼的事，也不知道自己身世的真相。',
  },
  {
    key: 'taboo', label: '禁忌与底线', hint: '碰到会怎样 —— 写反应，不写理由',
    ph: '例：被提起家人会沉默，然后转身走开；不会被激怒到动手。',
  },
  {
    key: 'care', label: '在意的事', hint: '软肋：什么能撬动她',
    ph: '例：在意别人怎么看待她父亲，一句轻蔑就能让她变色。',
  },
  {
    key: 'never', label: '绝不会做的事', hint: '防 OOC 的红线（最重要的一栏）',
    ph: '例：绝不会主动示弱，也绝不会为了讨好你而放弃自己的判断。',
  },
]

export type TavernCastSettingProps = {
  open: boolean
  cardId: string
  name: string
  /** 'ai' = AI 扮演（设定会作为「你要这样演」下发）；'user' = 作者扮演（仅作理解对方之用，明示不得代写） */
  kind: 'ai' | 'user'
  onClose: () => void
  /** 保存成功后回调（父级用来刷新「已设定」标记） */
  onSaved?: () => void
}

export default function TavernCastSetting({ open, cardId, name, kind, onClose, onSaved }: TavernCastSettingProps) {
  const [cs, setCs] = useState<CastSetting>({ ...EMPTY_CAST_SETTING })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 每次打开都重新读一遍：别的窗口/页签改过也能拿到最新值
  useEffect(() => {
    if (!open || !cardId) return
    let alive = true
    setLoading(true)
    void store.getCastSetting(cardId)
      .then(v => { if (alive) setCs({ ...EMPTY_CAST_SETTING, ...v }) })
      .catch(() => { if (alive) setCs({ ...EMPTY_CAST_SETTING }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, cardId])

  const set = (k: keyof CastSetting, v: string) => setCs(prev => ({ ...prev, [k]: v }))
  const filled = Object.values(cs).filter(v => v.trim()).length

  const save = async () => {
    setSaving(true)
    try {
      await store.saveCastSetting(cardId, cs)
      showToast('已保存扮演设定')
      onSaved?.()
      onClose()
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const clearAll = () => setCs({ ...EMPTY_CAST_SETTING })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`扮演设定 · ${name}`}
      width="lg"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <span className="text-[11px] text-ink-500">
            {loading ? '读取中…' : filled === 0 ? '六栏可全留空 —— 留空就不下发这一层' : `已填 ${filled} / 6 栏`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="md" onClick={clearAll} disabled={loading || saving}>清空</Button>
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button variant="primary" size="md" onClick={save} disabled={loading || saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="py-8 text-center text-[12px] text-ink-500">正在读取扮演设定…</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-ink-800 bg-ink-850/40 px-3 py-2 text-[11.5px] text-ink-400 leading-relaxed">
            {kind === 'ai' ? (
              <>这里写的是「<span className="text-amber">该怎么演她</span>」，不是背景资料 —— 背景走角色卡。
                塞行为，不塞设定：写「被提起家人会沉默」有用，写「她是某某的女儿」没用（卡片里已经有了）。</>
            ) : (
              <>这是<span className="text-amber">你自己演</span>的角色。填了只是让 AI 更懂对方的口吻与底线，
                <span className="text-ink-300">它不会代写你的台词</span>。</>
            )}
          </div>

          {FIELDS.map(f => (
            <section key={f.key}>
              <div className="flex items-baseline gap-2">
                <label className="text-[12px] text-ink-200">{f.label}</label>
                <span className="text-[11px] text-ink-500">{f.hint}</span>
              </div>
              <textarea
                className={`${inputCls} mt-1.5 h-16`}
                placeholder={f.ph}
                value={cs[f.key]}
                onChange={e => set(f.key, e.target.value)}
              />
            </section>
          ))}

          <div className="text-[11px] text-ink-500 border-t border-ink-800 pt-2 leading-relaxed">
            想不起怎么填时，先填<span className="text-ink-300">「绝不会做的事」</span> —— 它防 OOC 最有效。
          </div>
        </div>
      )}
    </Modal>
  )
}
