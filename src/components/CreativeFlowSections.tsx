/**
 * 创意写作 · 流程区（阶段时间线 + 设定与大纲闸门 + 连写日志 + 结果）（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useCreativeWritingModel（组件只收 m）。
 */
import DraftReviewPanel from '@/components/DraftReviewPanel'
import WorkflowTimeline from '@/components/WorkflowTimeline'
import { Button } from '@/components/Button'
import { resolveGate } from '@/lib/creativeSession'
import type { CreativeWritingModel } from '@/components/useCreativeWritingModel'

export default function CreativeFlowSections({ m }: { m: CreativeWritingModel }) {
  const { s, inp } = m
  return (
    <>
      {/* 阶段进度：竖向节点时间线（跑完保留 —— 事后能看到每一步做了什么、花了多久、产出多少） */}
      <WorkflowTimeline progress={s.progress} running={s.running} summaries={s.summaries} className="mt-2" />

      {/* 闸门 · 设定：设定草稿 */}
      {s.bibleGate && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 设定</span>
            <span className="text-13 text-ink-100">确认设定草稿</span>
            <span className="text-11 text-ink-500">
              只有勾选的条目会落库；可以改名称、也可以直接舍弃不要的
            </span>
            <div className="flex-1" />
            {/* 与下方 DraftReviewPanel 的「确认设定」（sm）同一决策组 —— 尺寸必须一致 */}
            <Button size="sm" variant="secondary" onClick={() => resolveGate(null)}>放弃本次创作</Button>
          </div>
          <DraftReviewPanel
            bundle={s.bibleGate}
            onConfirm={rows => resolveGate(rows)}
            confirmText="确认设定"
          />
        </div>
      )}

      {/* 闸门 · 大纲 */}
      {s.outlineGate && (
        <section className="mt-4 rounded-lg border border-amber/40 bg-ink-800/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 大纲</span>
            <span className="text-13 text-ink-100">
              确认分卷大纲（{s.outlineGate.volumes.length} 卷 / {s.outlineGate.chapters.length} 章）
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => resolveGate(false)}>放弃本次创作</Button>
            {/* 「要不要正文」在起点就定了，闸门只做确认 / 放弃 —— 按钮文案跟着目标变 */}
            <Button size="sm" variant="primary" solid onClick={() => resolveGate(true)}>
              {inp.target === 'outline' ? '确认大纲（不写正文）' : '保存大纲并开始连写'}
            </Button>
          </div>

          {/* 🔴 key 用序号而非卷标题（2026-09-19 六维审计 P2-11）：标题是模型产出的，同名卷
              理论上会撞 → React 按名复用节点、内容错位。这份列表是闸门预览、不存在重排，
              序号最稳（顺带避开「标题相同就报 key 重复」的控制台噪音）。 */}
          {s.outlineGate.volumes.map((v, vi) => (
            <div key={`vol-${vi}`} className="mb-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
              <div className="text-12 text-ink-100">《{v.title}》</div>
              {v.positioning && <div className="mt-0.5 text-11 text-ink-300">{v.positioning}</div>}
              {v.events && <div className="mt-0.5 text-10 text-ink-500">事件链：{v.events}</div>}
              {v.ending && <div className="mt-0.5 text-10 text-ink-500">卷末：{v.ending}</div>}
            </div>
          ))}

          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-ink-700 bg-ink-900/40">
            <ul>
              {s.outlineGate.chapters.map((c, ci) => (
                <li key={`ch-${ci}`} className="border-b border-ink-700/40 px-3 py-1.5 last:border-0">
                  <div className="text-11 text-ink-200">第{c.no}章 {c.title}</div>
                  {c.event && <div className="text-10 text-ink-400">{c.event}</div>}
                  {c.hook && <div className="text-10 text-ink-500">章末钩子：{c.hook}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-2 text-10 leading-relaxed text-ink-500">
            {inp.target === 'outline'
              ? '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，本次到此为止（你选的是「只做大纲规划」，不写正文）；之后用「接着已有内容写」就能按细纲把正文补上。'
              : '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，然后按细纲逐章连写正文；同名卷/细纲不会重复创建。'}
          </div>
        </section>
      )}

      {/* 连写日志 */}
      {s.log.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          {s.log.map((l, i) => (
            <div key={i} className="text-11 text-ink-300">{l}</div>
          ))}
        </div>
      )}

      {/* 结果 */}
      {s.result && (
        <section className="mt-4 rounded-lg border border-success/30 bg-success/5 p-4">
          <div className="text-13 text-success">
            {s.result.wrote > 0 || s.result.outlineOnly ? '本次完成' : '本次结束'}
          </div>
          <ul className="mt-1.5 space-y-0.5 text-11 text-ink-300">
            {s.result.mode === 'scratch' && (
              <>
                <li>设定：{s.result.bibleTotal} 条草稿
                  {s.result.bibleCreated > 0 && ` → 新建 ${s.result.bibleCreated} 条`}
                </li>
                <li>大纲：{s.result.volumes} 卷 / {s.result.outlineChapters} 章</li>
              </>
            )}
            <li>
              {s.result.outlineOnly
                ? '正文：按你的选择只出大纲，未写正文'
                : `正文：${s.result.wrote} 章已落库`}
            </li>
          </ul>
          <div className="mt-1.5 text-10 text-ink-500">
            {s.result.outlineOnly
              ? '设定与大纲已落库（角色管理 / 世界构建 / 大纲规划）；想写正文时切到「接着已有内容写」，不必重跑设定与大纲。'
              : '去「正文编辑」看正文；设定与大纲分别在对应页签（角色管理 / 世界构建 / 大纲规划）。'}
          </div>
        </section>
      )}

    </>
  )
}
