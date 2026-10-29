// 3.3.1 · P7「定位原文」隔离探针夹具
//
// 只装「请求通道 + 正文消费 hook + 返回提示条」这三件，不装校对弹窗与模型：
// 弹窗里的按钮能不能点属于静态接入（单测守），这里要验的是**跳过去之后到底对不对** ——
// 选区落在哪、正文有没有被改、滚动有没有到位、跨章会不会乱跳、内容改了会不会跳到别的句子。
import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useProofLocateJump } from '../../src/components/editor/useProofLocateJump'
import { requestProofLocate, type ProofLocateTarget } from '../../src/components/editor/proofLocateChannel'
import { ProofLocateReturnBar } from '../../src/components/editor/ProofLocateReturnBar'

/** 目标句排在靠后段落：定位必须滚动才能看见，否则「滚动正确」验不出来 */
const BODY = Array.from({ length: 40 }, (_, i) => `第${i + 1}段：他走进房间，看见窗外的雨。`).join('\n')
const QUOTE = '第40段：他走进房间'

const host = window as unknown as {
  locate: (target: ProofLocateTarget) => boolean
  body: string
  quote: string
  returned: number | null
  locates: number
}

function Fixture() {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(BODY)
  const [located, setLocated] = useState<{ start: number; end: number } | null>(null)
  const { prompt, dismiss } = useProofLocateJump({ chapterId: 'ch-1', taRef, onLocated: setLocated })
  useEffect(() => {
    host.body = BODY
    host.quote = QUOTE
    host.returned = null
    host.locates = 0
    host.locate = target => { host.locates += 1; return requestProofLocate(target) }
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
      <textarea ref={taRef} aria-label="正文" value={text} onChange={event => setText(event.target.value)}
        style={{ height: 220, width: 420, fontSize: 14, lineHeight: 1.9, padding: 12 }} />
      <output data-located="">{located ? `${located.start}-${located.end}` : ''}</output>
      {prompt && (
        <ProofLocateReturnBar index={prompt.index} total={prompt.total} quote={prompt.quote}
          onReturn={() => { host.returned = prompt.issueKey; dismiss() }} onDismiss={dismiss} />
      )}
    </div>
  )
}

createRoot(document.getElementById('fixture')!).render(<Fixture />)
