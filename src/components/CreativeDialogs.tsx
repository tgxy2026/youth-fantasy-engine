/**
 * 创意写作 · 两个弹窗（每章初稿裁决 / 设定补登确认）（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useCreativeWritingModel（组件只收 m）。
 */
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { applyCandidates, decideDraft, toggleCandidate } from '@/lib/creativeSession'
import { WORD_TOLERANCE } from '@/lib/autoContinue'
import { foldVh } from '@/lib/theme'
import type { CreativeWritingModel } from '@/components/useCreativeWritingModel'

export default function CreativeDialogs({ m }: { m: CreativeWritingModel }) {
  const { s, inp } = m
  return (
    <>
      {/* 每章初稿裁决（逐章确认开启时） */}
      <Modal
        open={!!s.draftAsk}
        onClose={() => decideDraft('abort')}
        width="2xl"
        title={s.draftAsk ? `第 ${s.draftAsk.d.index}/${s.draftAsk.d.total} 章初稿${s.draftAsk.d.attempt > 1 ? `（第 ${s.draftAsk.d.attempt} 稿）` : ''}` : '本章初稿'}
        footer={
          <>
            <Button variant="secondary" onClick={() => decideDraft('abort')}>停止任务</Button>
            <Button variant="secondary" onClick={() => decideDraft('rewrite')}>重写本章</Button>
            <Button variant="primary" solid onClick={() => decideDraft('accept')}>采纳本章</Button>
          </>
        }
      >
        {s.draftAsk && (() => {
          const d = s.draftAsk.d
          const lo = d.target - WORD_TOLERANCE
          const hi = d.target + WORD_TOLERANCE
          const ok = d.words >= lo && d.words <= hi
          return (
            <>
              <div className="mb-3 flex items-center gap-3 text-12">
                <span className={ok ? 'text-success' : 'text-amber'}>
                  {d.words} 汉字 {ok ? '· 已达标' : '· 超出容差'}
                </span>
                <span className="text-ink-500">目标 {d.target} ± {WORD_TOLERANCE}（{lo}~{hi}）</span>
                {inp.deAiOn && <span className="text-ink-300 border border-ink-700 rounded px-1.5 py-0.5">已去 AI 味儿</span>}
              </div>
              <p className="text-12 text-ink-400 mb-3">
                采纳后 AI 才会继续做编辑自检、修正与设定补登；点「重写本章」会丢弃本稿重新生成
                （含重新润色，不会留下垃圾章节，也不会写入数据库）。
                不想每章都停一次，可关掉上面的「逐章确认初稿」。
              </p>
              <div className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3.5 text-13 leading-[1.9] text-ink-100"
                style={{ maxHeight: foldVh('52vh') }}>
                {d.body}
              </div>
            </>
          )
        })()}
      </Modal>

      {/* 设定补登确认（策略选「候选确认」时） */}
      <Modal
        open={!!s.candidatesAsk}
        onClose={() => applyCandidates(null)}
        title="设定补登确认"
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => applyCandidates(null)}>跳过</Button>
            <Button variant="primary" onClick={() =>
              applyCandidates((s.candidatesAsk?.cands ?? []).filter(c => s.candidatesSelected.includes(c.key)))
            }>
              确认补登（{s.candidatesSelected.length}）
            </Button>
          </>
        }
      >
        <p className="text-12 text-ink-400 mb-3">
          勾选要补登到设定表 / 角色卡的条目。绿色=新设定，黄色=疑似已存在需你确认；已登记项不会改动。
        </p>
        <div className="max-h-80 overflow-auto space-y-2">
          {s.candidatesAsk?.cands.map(c => (
            <label key={c.key} className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900 p-2 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={s.candidatesSelected.includes(c.key)}
                onChange={e => toggleCandidate(c.key, e.target.checked)} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-13 text-ink-50 font-medium">{c.name}</span>
                  <span className="text-11 text-ink-400">{c.type}</span>
                  <span className={`text-11 px-1 rounded ${c.status === 'new' ? 'bg-emerald-900/40 text-success' : 'bg-amber-900/40 text-amber-300'}`}>
                    {c.status === 'new' ? '新设定' : '疑似重复'}
                  </span>
                </div>
                {c.desc && <div className="text-12 text-ink-300 mt-0.5 break-words">{c.desc}</div>}
              </div>
            </label>
          ))}
        </div>
      </Modal>
    </>
  )
}
