// ============ 使用答疑助手 · 问 AI（3.3.1 · P4） ============
//
// 规划 §5.1 / §7：界面统一叫「使用答疑助手」，内部区分「查手册」与「问 AI」。
// 三条纪律：
//   ① **不配模型也能用** —— 打开就能提问，本地检索照样出结果；只是标注「这一条不是 AI 回答」；
//   ② **回答必须带依据** —— 每条来源可点开原文那一段；校验不过就退回检索结果，不显示半真半假的答案；
//   ③ **对话只在内存** —— 关掉面板即丢；不写项目数据、不写问题与回答全文（规划 §7 末段）。
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, BookOpen, CornerDownRight, HelpCircle, Loader2, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { useAIReady } from '@/lib/ai/useAIReady'
import {
  CONTENT_VERSION, HELP_RELOAD_LABEL, checkHelpBuild, getHelpArticle, topicFromAnswer, type AskTopic, type HelpHit,
} from '@/lib/help'
import { askHelpOnce, type AskResult } from '@/lib/aiTasks/helpAsk'
import { helpSourceSnapshot } from '@/lib/aiTasks/helpAnswer'

/** 一条消息：只有「提问」与「结果」两种，结果保留原始 kind 以便如实渲染 */
type Turn =
  | { id: number; role: 'question'; text: string }
  | { id: number; role: 'result'; result: AskResult }

interface Props {
  /** 当前页签：只用于检索加权，不进提示词 */
  currentTabId?: string | null
  /** 点开某篇手册的某一段（由 HelpCenter 提供，复用它的返回现场） */
  onOpenArticle: (articleId: string, sectionId?: string) => void
}

const sectionOf = (articleId: string, sectionId: string): string => {
  const article = getHelpArticle(articleId)
  return article?.sections.find(section => section.id === sectionId)?.heading ?? sectionId
}

/**
 * 重新加载帮助资源。
 *
 * 🔴 只做「刷新页面」这一件事：不在这里尝试热替换内容、也不清缓存。
 *    混版本的成因是外壳与 chunk 来自不同构建，只有整页重新拉取才能保证两边同时换新；
 *    自作聪明地局部重建只会把「不知道哪个版本」变成「一半新一半旧」。
 */
const reloadHelpResources = () => {
  if (typeof window !== 'undefined') window.location.reload()
}

export default function AskPanel({ currentTabId, onOpenArticle }: Props) {
  const { ready: aiReady } = useAIReady()
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState(false)
  const [staleSourceTurn, setStaleSourceTurn] = useState<number | null>(null)
  /**
   * 上一轮**已验证**的主题（规划 §5.5）。只有 `kind:'answer'` 会写入它 ——
   * 失败输出、未校验流、"没有依据"都不会成为下一轮的上下文。
   */
  const [lastTopic, setLastTopic] = useState<AskTopic | null>(null)
  const nextId = useRef(1)
  /** 取消信号 + 代次：晚到的结果不许覆盖新一轮（连点、停止后重问都会发生） */
  const abort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 卸载即中断：面板关掉后不让请求继续跑（规划 §7「关闭面板不等同取消」说的是**后台任务**，
  // 答疑不用后台任务，它是一次同步问答）
  useEffect(() => () => abort.current?.abort(), [])

  const scrollToEnd = () => requestAnimationFrame(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  })

  const submit = async (raw: string) => {
    const text = raw.trim()
    if (!text || pending) return
    const askId = nextId.current++
    setQuestion('')
    setTurns(prev => [...prev, { id: askId, role: 'question', text }])
    setPending(true)
    scrollToEnd()

    const controller = new AbortController()
    abort.current = controller
    const mine = ++generation.current
    // 追问上下文只带「上一轮已验证的主题」，不带整段历史（规划 §5.5）
    const result = await askHelpOnce(text, currentTabId, controller.signal, undefined, { lastTopic })

    // 代次不符说明这一轮已经作废（作者停止后又问了一次），结果直接丢弃
    if (mine !== generation.current) return
    abort.current = null
    setPending(false)
    setTurns(prev => [...prev, { id: nextId.current++, role: 'result', result }])
    // 🔴 只有校验通过的回答才更新主题：答不出来时不把「半个答案」变成下一轮的依据
    if (result.kind === 'answer') {
      const topic = topicFromAnswer(text, result.answer, result.sources)
      if (topic) setLastTopic(topic)
    }
    scrollToEnd()
  }

  const stop = () => {
    generation.current++
    abort.current?.abort()
    abort.current = null
    setPending(false)
    setTurns(prev => (prev.length === 0 ? prev : [...prev, {
      id: nextId.current++, role: 'result',
      result: { kind: 'cancelled', hits: [] },
    }]))
  }

  /** 检索结果列表：答不出时的落脚点，也是「AI 没配也能查」的保证 */
  const hitList = (hits: HelpHit[]) => (
    <div className="space-y-1.5">
      {hits.map(hit => (
        <Button key={`${hit.articleId}-${hit.sectionId}`} variant="bare"
          onClick={() => onOpenArticle(hit.articleId, hit.sectionId)}
          className="flex-col items-stretch w-full text-left rounded-lg bg-ink-800 border border-ink-700 px-3 py-2 hover:border-amber/40 transition-colors">
          <div className="flex items-center gap-1.5">
            <span className="text-11 font-semibold text-ink-100">{hit.articleTitle}</span>
            <span className="text-9 text-amber/80">{hit.heading}</span>
          </div>
          <div className="text-10 text-ink-400 mt-0.5 leading-relaxed line-clamp-2">{hit.excerpt}</div>
        </Button>
      ))}
    </div>
  )

  /**
   * 「本次参考」：规划 §5.5 要求跨功能 / 切页后继续提问时**显示当前参考主题**，
   * 否则作者看不出这句「那…」是在接哪一问。只在真的借用了上一问主题时出现。
   */
  const topicChip = (topic?: AskTopic | null) => (topic ? (
    <div data-help-topic className="flex items-start gap-1 text-10 text-ink-500 leading-relaxed">
      <CornerDownRight size={10} className="mt-0.5 shrink-0" />
      <span>接着上一问：{topic.titles.join('、')}</span>
    </div>
  ) : null)

  const resultBody = (result: AskResult, turnId: number) => {
    if (result.kind === 'answer') {
      return (
        <div className="space-y-2">
          {topicChip(result.topic)}
          <div className="text-12 text-ink-200 leading-relaxed whitespace-pre-wrap">{result.answer}</div>
          {result.sources.length > 0 && (
            <div className="space-y-1 border-t border-ink-700/60 pt-2">
              <div className="text-10 text-ink-500">依据（点开看原文那一段）</div>
              {result.sources.map(source => (
                <Button key={`${source.articleId}-${source.sectionId}`} variant="bare"
                  onClick={() => {
                    const key = `${source.articleId}/${source.sectionId}`
                    if (helpSourceSnapshot(source.articleId, source.sectionId) !== result.sourceSnapshots[key]) {
                      setStaleSourceTurn(turnId)
                      return
                    }
                    setStaleSourceTurn(null)
                    onOpenArticle(source.articleId, source.sectionId)
                  }}
                  className="flex-col items-stretch w-full text-left rounded-md border border-ink-700 bg-ink-800/60 px-2 py-1.5 hover:border-amber/40 transition-colors">
                  <div className="text-10 text-amber/80">
                    《{getHelpArticle(source.articleId)?.title ?? source.articleId}》· {sectionOf(source.articleId, source.sectionId)}
                  </div>
                  <div className="text-10 text-ink-400 mt-0.5 line-clamp-2">「{source.quote}」</div>
                </Button>
              ))}
            </div>
          )}
          {staleSourceTurn === turnId && <div role="status" className="text-11 text-amber">这条回答所依据的手册内容已变化，请重新提问后查看新原文。</div>}
          <div className="text-9 text-ink-600">
            回答只依据内置手册（v{result.contentVersion}），不读取你的稿件内容。
            {result.contentVersion !== CONTENT_VERSION && (
              <span className="text-amber/80"> 这条回答基于手册 v{result.contentVersion}，当前为 v{CONTENT_VERSION}：点开依据看到的是当时的原文快照，若已更新请重新提问。</span>
            )}
          </div>
        </div>
      )
    }
    if (result.kind === 'cancelled') {
      return <div className="text-11 text-ink-500">已停止这一轮提问。可以改个说法再问一次。</div>
    }
    /** 混版本：不是「没配模型」也不是「手册没写」，是资源本身不同步 */
    if (result.kind === 'stale') {
      return (
        <div className="space-y-2">
          <div className="flex items-start gap-1.5 text-11 leading-relaxed text-amber/90">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{result.message}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={reloadHelpResources} className="flex items-center gap-1 text-11">
              <RefreshCw size={11} /> {HELP_RELOAD_LABEL}
            </Button>
          </div>
          {/* 🔴 这里原有一个「换用本地手册检索」按钮，已去掉：混版本闸在 askHelpOnce 最前面，
              再怎么问都会同样返回混版本 —— 那个按钮点下去只会多一条一模一样的提示。
              手册文章本来就不受影响，说明白即可，不做一个点不出结果的按钮。 */}
          <div className="text-10 text-ink-500">手册文章不受影响：切到「查手册」仍可正常翻阅，界面也可以继续用。</div>
        </div>
      )
    }
    /**
     * 像追问、但不知道在问哪个功能：**本地澄清**，不请求模型（规划 §5.5）。
     * 🔴 不能默认「这个」就是刚打开的那一页 —— 那会把作者的问题答到别的功能上。
     */
    if (result.kind === 'clarify') {
      return (
        <div data-help-clarify className="space-y-2">
          <div className="flex items-start gap-1.5 text-11 leading-relaxed text-ink-300">
            <HelpCircle size={12} className="mt-0.5 shrink-0" />
            <span>{result.message}</span>
          </div>
          {result.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.options.map(option => (
                <Button key={option.articleId} variant="bare"
                  onClick={() => void submit(option.title)}
                  title={`按《${option.title}》继续提问`}
                  className="px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
                  {option.title}
                </Button>
              ))}
            </div>
          )}
        </div>
      )
    }
    /** 三种「没有 AI 回答」的情况：措辞必须分得清，不能都说成「手册没写」 */
    const notice = result.kind === 'no-model'
      ? '还没有配置可用的 AI 模型，这一条不是 AI 回答。下面是本地手册检索到的片段，可直接点开看：'
      : result.kind === 'no-recall'
        ? '本地手册里没有找到直接对应的段落。可以换个说法，或者到「查手册」里按功能找：'
        : result.message
    return (
      <div className="space-y-2">
        {topicChip(result.topic)}
        <div className={`flex items-start gap-1.5 text-11 leading-relaxed ${result.kind === 'no-recall' ? 'text-ink-300' : 'text-amber/90'}`}>
          {result.kind === 'fallback' && <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
          <span>{notice}</span>
        </div>
        {result.hits.length > 0 && hitList(result.hits)}
        {result.kind === 'fallback' && (
          <div className="text-10 text-ink-500">下面的片段仍可当答案用，只是没有经过模型改写。</div>
        )}
      </div>
    )
  }

  const build = checkHelpBuild()

  return (
    <div data-ask-panel className="space-y-3">
      {/* 🔴 混版本时先说明再提供入口（规划 §4.4）：提问会被拒绝，不能让作者以为模型坏了 */}
      {!build.aligned && (
        <div data-help-build-mismatch
          className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-11 text-amber/90 leading-relaxed space-y-1.5">
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>手册资源版本不一致（页面外壳与内容包不是同一次加载）。为避免按旧内容回答，已暂停 AI 回答；手册文章仍可正常阅读。</span>
          </div>
          <Button variant="secondary" size="sm" onClick={reloadHelpResources}
            className="flex items-center gap-1 text-11">
            <RefreshCw size={11} /> {HELP_RELOAD_LABEL}
          </Button>
          <div className="text-10 text-amber/70">外壳 {build.shell ?? '（未标注）'} · 内容包 {build.bundle}</div>
        </div>
      )}
      <div className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-3 py-2 text-11 text-ink-400 leading-relaxed">
        回答只依据内置手册，不读你的稿件、不改任何数据；对话只在本次打开期间存在，关闭即清空。
        {!aiReady && <span className="text-amber/80"> 未配置模型时只能给手册片段，不会有 AI 回答。</span>}
      </div>

      <div ref={listRef} className="max-h-80 overflow-y-auto space-y-2 pr-1">
        {turns.length === 0 && (
          <div className="py-6 text-center space-y-2">
            <div className="text-12 text-ink-300">问一句，比如「字太小怎么放大」「校对怎么跳到原文」</div>
            <div className="text-11 text-ink-600">不会写进项目；使用 AI 回答时，问题和相关手册片段会发送给所选模型服务。</div>
            <div className="flex flex-wrap justify-center gap-1.5 pt-1">
              {['字太小怎么放大', '怎么跳到校对问题原文', '换电脑怎么带走数据'].map(sample => (
                <Button key={sample} variant="bare" onClick={() => void submit(sample)}
                  className="px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
                  {sample}
                </Button>
              ))}
            </div>
          </div>
        )}
        {turns.map(turn => (
          turn.role === 'question' ? (
            <div key={turn.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg rounded-br-sm bg-amber/15 border border-amber/25 px-3 py-1.5 text-11 text-ink-100 whitespace-pre-wrap">
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={turn.id} className="rounded-lg bg-ink-850 border border-ink-700 px-3 py-2">
              {resultBody(turn.result, turn.id)}
            </div>
          )
        ))}
        {pending && (
          <div className="flex items-center gap-1.5 text-11 text-ink-500 px-1">
            <Loader2 size={12} className="animate-spin" /> 正在按手册回答……
          </div>
        )}
      </div>

      <div data-help-composer className="flex items-end gap-2">
        <textarea
          aria-label="向答疑助手提问"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            // Enter 发送、Shift+Enter 换行；输入法组合中不拦（否则中文打字会误发）
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit(question)
            }
          }}
          rows={2}
          placeholder="问一句这个功能怎么用（Enter 发送，Shift+Enter 换行）"
          className="flex-1 min-w-0 resize-none rounded-lg bg-ink-900 border border-ink-700 px-3 py-2 text-11 text-ink-100 placeholder:text-ink-600 outline-none focus:border-amber/40 transition-colors"
        />
        {pending ? (
          <Button variant="secondary" size="sm" onClick={stop} className="flex items-center gap-1 text-11 shrink-0">
            <Square size={11} /> 停止
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={!question.trim()}
            onClick={() => void submit(question)} className="flex items-center gap-1 text-11 shrink-0">
            <Send size={11} /> 提问
          </Button>
        )}
        {turns.length > 0 && !pending && (
          <Button variant="secondary" size="sm" onClick={() => { setTurns([]); setLastTopic(null) }}
            title="清空本次对话（不影响任何数据，也不会删除运行统计）"
            className="flex items-center gap-1 text-11 shrink-0">
            <Trash2 size={11} /> 清空
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-10 text-ink-600">
        <BookOpen size={10} /> 想自己找？切到「查手册」按功能翻阅
        <ArrowRight size={10} />
      </div>
    </div>
  )
}
