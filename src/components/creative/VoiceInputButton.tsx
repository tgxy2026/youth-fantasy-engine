/**
 * 语音录入按钮（3.7.0 · W7）
 *
 * 纪律：
 *   · **显式录音**：必须点「开始」/「结束」，绝不静默开麦；录音中红点 + 计时；
 *   · 上限 120 秒 / 10MB，先到先停；
 *   · 录音只存在内存，转写后即弃；文本先放进输入框由作者编辑再保存；
 *   · 未配置转写服务时按钮不可用并如实说明原因。
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import {
  loadTranscribeConfig, transcribeAudio, transcribeReady, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, type TranscribeConfig,
} from '@/lib/aiCore/transcribe'

export default function VoiceInputButton({ onText, label = '语音' }: { onText: (text: string) => void; label?: string }) {
  const [cfg, setCfg] = useState<TranscribeConfig | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopRef = useRef<() => void>(() => undefined)

  useEffect(() => { void loadTranscribeConfig().then(setCfg).catch(() => setCfg(null)) }, [])
  useEffect(() => () => { timerRef.current && clearInterval(timerRef.current); recorderRef.current?.state === 'recording' && recorderRef.current.stop() }, [])

  const ready = !!cfg && transcribeReady(cfg)

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }

  const finish = async (blob: Blob) => {
    setBusy(true)
    try {
      if (!cfg) return
      if (blob.size > VOICE_MAX_BYTES) { showToast('录音超过 10MB 上限，请缩短后重录', 'info'); return }
      const r = await transcribeAudio(blob, cfg)
      if (!r.ok) { showToast(r.detail ?? '转写失败，请重试', 'error'); return }
      onText(r.text ?? '')
      showToast('已转写，先核对再保存', 'success')
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    if (!ready) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('这个环境不支持录音（需要 HTTPS / localhost 且浏览器允许麦克风）', 'error')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) ?? ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        stopTimer()
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 0) void finish(blob)
      }
      recorderRef.current = rec
      rec.start(1000)
      setRecording(true)
      setSeconds(0)
      stopRef.current = () => { if (recorderRef.current?.state === 'recording') recorderRef.current.stop() }
      timerRef.current = setInterval(() => {
        setSeconds(s => {
          if (s + 1 >= VOICE_MAX_SECONDS) { stopRef.current(); return VOICE_MAX_SECONDS }
          return s + 1
        })
      }, 1000)
    } catch {
      showToast('麦克风没有打开（可能是权限被拒）。不会在未授权时录音。', 'error')
    }
  }

  const stop = () => { stopRef.current() }

  return (
    <div className="inline-flex items-center gap-1.5">
      {recording ? (
        <Button variant="secondary" size="sm" onClick={stop} title="结束录音并转写">
          <Square size={11} className="text-danger" /> 结束（{seconds}s / {VOICE_MAX_SECONDS}s）
        </Button>
      ) : (
        <Button variant="secondary" size="sm" disabled={!ready || busy} onClick={() => void start()}
          title={ready ? '录音会发送到你配置的转写服务；本应用不留存音频' : '需先在「模型设置 → 语音转写」配置服务'}>
          <Mic size={11} /> {busy ? '转写中…' : label}
        </Button>
      )}
      {!ready && <span className="text-10 text-ink-500">需先配置转写服务</span>}
      {recording && <span className="text-10 text-danger">● 录音中（音频不上传直到你点结束）</span>}
    </div>
  )
}