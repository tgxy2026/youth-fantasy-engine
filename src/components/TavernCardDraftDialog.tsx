/**
 * 角色卡 · AI 起草弹窗（一句话 → 按四章模板填）
 *
 * 【两种创建方式的入口之一】另一个是「对话引导」（`TavernInterviewDialog`）。
 * 分工：**已经想清楚**（甚至照着某个已有角色）→ 一句话起草；**只有个感觉** → 对话引导。
 *
 * 【为什么先给预览再「填入」】
 * 起草是一次模型调用，结果可能离谱。直接写进卡面会让作者分不清「哪些字是我写的、哪些是它写的」；
 * 先摊开看一眼、再决定要不要，成本几乎为零，却省掉一次「改回来」。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import AutoTextarea from '@/components/AutoTextarea'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from '@/components/DraftBits'
import {
  draftCard, EMPTY_CARD_DRAFT, isEmptyCardDraft, type CardDraft, type DraftSource,
} from '@/lib/tavern/draft'

/** 十三栏的显示名（预览用；顺序＝四章顺序） */
const CARD_FIELD_LABELS: [keyof CardDraft, string][] = [
  ['name', '名字'],
  ['world', '第 1 章 · 角色与设定的关系'],
  ['externals', '外在'],
  ['core', '内核'],
  ['speech', '语言特征'],
  ['relations', '关系'],
  ['cannot', '做不到的事'],
  ['knowledge', '知识边界'],
  ['perspective', '视角与人称'],
  ['bottomLine', '底线清单'],
  ['paceLock', '进度锁'],
  ['rating', '尺度'],
  ['examples', '示例对话'],
]

export default function TavernCardDraftDialog({ open, existing, onClose, onApply }: {
  open: boolean
  /** 补完模式：现有卡面的摊平文本 */
  existing?: string
  onClose: () => void
  onApply: (fields: CardDraft, source: DraftSource) => void
}) {
  const [idea, setIdea] = useState('')
  const [refs, setRefs] = useState('')
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<CardDraft | null>(null)
  const [source, setSource] = useState<DraftSource | null>(null)
  const [err, setErr] = useState('')
  const search = useSearchSettings()

  useEffect(() => {
    if (!open) return
    setIdea(''); setRefs(''); setBusy(false); setFields(null); setSource(null); setErr('')
  }, [open])

  const preview = useMemo(
    () => (fields ? CARD_FIELD_LABELS.filter(([k]) => String(fields[k] ?? '').trim()) : []),
    [fields],
  )

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await draftCard({
        idea, refs,
        ...(existing?.trim() ? { existing } : {}),
        settings: search ?? { mode: 'off', engine: 'bocha', endpoint: '', apiKey: '', topK: 5 },
      })
      setFields(res.fields)
      setSource(res.source)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open} onClose={onClose} title="AI 起草角色卡" width="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-500">
            {err ? '生成失败' : fields
              ? `生成了 ${preview.length} 栏 —— 填入后仍是草稿，记得逐栏核对再保存`
              : '先写一句想法（或粘一段素材）'}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>关闭</Button>
            <Button
              variant="primary" size="md"
              disabled={!fields || preview.length === 0 || busy}
              onClick={() => {
                if (!fields || !source) return
                onApply(fields, source)
                onClose()
              }}
            >
              填入卡面
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.1fr]">
        {/* 左：输入 */}
        <div className="space-y-3">
          <div>
            <div className="text-11 text-ink-400">一句话想法</div>
            <AutoTextarea
              value={idea}
              onChange={setIdea}
              minRows={3}
              maxHeight={160}
              placeholder={'例：以《最终幻想 7》里的蒂法为原型做一张卡。\n例：一个在城南开了二十年旧书店的老板，脾气古怪但心软。'}
            />
          </div>
          <RefsField value={refs} onChange={setRefs} minRows={3} />
          <SearchPlanLine settings={search} />
          <Button
            variant="primary" size="md" className="w-full"
            disabled={busy || (!idea.trim() && !refs.trim() && !existing?.trim())}
            onClick={() => void run()}
          >
            {busy ? '正在起草…' : fields ? '重新起草' : '开始起草'}
          </Button>
          <DraftSourceLine source={source} />
          {err && <p className="text-11 leading-relaxed text-amber">⚠️ {err}</p>}
          {existing?.trim() && (
            <p className="text-10 leading-relaxed text-ink-600">
              当前卡面已有内容：会当作「补完」的起点交给 AI —— 你已经写好的栏不会被动，它只补缺。
            </p>
          )}
        </div>

        {/* 右：预览 */}
        <div className="min-h-0">
          <div className="text-11 text-ink-400">起草结果预览</div>
          {!fields ? (
            <p className="mt-1.5 rounded-md border border-dashed border-ink-700 p-4 text-center text-11 text-ink-500">
              生成后会在这里逐栏摊开 —— 看完再决定要不要填进卡面。
            </p>
          ) : preview.length === 0 ? (
            <p className="mt-1.5 text-11 text-amber">模型什么都没写出来（十三栏全空），换个说法再试一次。</p>
          ) : (
            <div className="mt-1.5 max-h-[26rem] space-y-2 overflow-y-auto pr-1">
              {preview.map(([k, label]) => (
                <div key={k} className="rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                  <div className="text-11 text-amber">{label}</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-11 leading-relaxed text-ink-300">{fields[k]}</div>
                </div>
              ))}
              {CARD_FIELD_LABELS.some(([k]) => !String(fields[k] ?? '').trim()) && (
                <p className="text-10 text-ink-600">
                  空着的栏：{CARD_FIELD_LABELS.filter(([k]) => !String(fields[k] ?? '').trim()).map(([, l]) => l).join('、')}
                  {' '}（AI 拿不准的栏会留空 —— 比瞎编强，之后自己补）
                </p>
              )}
            </div>
          )}
          {fields && isEmptyCardDraft(fields) && (
            <p className="mt-1 text-10 text-ink-500">（提示：也可以用「对话引导」边聊边塑形，适合还没想清楚的时候。）</p>
          )}
        </div>
      </div>
    </Modal>
  )
}

export { CARD_FIELD_LABELS, EMPTY_CARD_DRAFT }
