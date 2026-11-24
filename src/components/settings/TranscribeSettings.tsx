/**
 * 语音转写配置（3.7.0 · W7）
 *
 * 🔴 仅通用 OpenAI 兼容配置（D3 拍板）：作者自填 baseUrl / apiKey / model，不内置服务商预设。
 * 🔴 独立于聊天模型：不参与聊天模型列表，也不改变 `transport` 的模型过滤口径。
 * 🔴 隐私：音频只发往这里填的服务；本应用不落盘、不进备份/云同步/诊断包。
 */
import { useEffect, useState } from 'react'
import Panel from '@/components/common/Panel'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import HelpPopover from '@/components/common/HelpPopover'
import {
  loadTranscribeConfig, saveTranscribeConfig, transcribeReady, TRANSCRIBE_DEFAULT_MODEL, type TranscribeConfig,
} from '@/lib/aiCore/transcribe'

export default function TranscribeSettings() {
  const [cfg, setCfg] = useState<TranscribeConfig>({ baseUrl: '', apiKey: '', model: TRANSCRIBE_DEFAULT_MODEL })
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadTranscribeConfig().then(c => { if (!cancelled) { setCfg(c); setSaved(transcribeReady(c)) } }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const ready = transcribeReady(cfg)

  const save = async () => {
    try {
      await saveTranscribeConfig(cfg)
    } catch {
      showToast('转写配置没写进去（存储失败），请重试', 'error')
      return
    }
    setSaved(transcribeReady(cfg))
    showToast(transcribeReady(cfg) ? '转写配置已保存' : '已保存，但还不能用（地址或 Key 为空）', transcribeReady(cfg) ? 'success' : 'info')
  }

  return (
    <Panel data-guide="settings-transcribe">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-13 font-semibold text-ink-100">语音转写</h2>
        <span className={`text-10 px-1.5 py-0.5 rounded border ${saved ? 'border-success/30 text-success bg-success/10' : 'border-ink-600 text-ink-400 bg-ink-800'}`}>
          {saved ? '已配置' : '未配置'}
        </span>
        <HelpPopover title="语音转写怎么用" width="22rem">
          {'灵感夹与随手记的「🎤 语音」用它把录音转成文字。\n\n'
            + '· 只支持 OpenAI 兼容的 /audio/transcriptions 接口：填服务根地址（如 https://api.example.com/v1）、Key 与模型名；\n'
            + '· 不内置任何服务商预设，也不参与聊天模型列表；\n'
            + '· 录音会发送到上面填的服务。本应用不留存音频，也不把音频写进备份、云同步或诊断信息；\n'
            + '· 转写文本会先放进输入框，你核对修改后再保存。'}
        </HelpPopover>
      </div>
      <p className="text-10 text-ink-500 mb-2">独立于聊天模型。未配置时「语音」按钮不可用；转写失败时音频直接丢弃。</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-11 text-ink-300 flex flex-col gap-1">
          服务地址（baseUrl）
          <input value={cfg.baseUrl} onChange={e => setCfg({ ...cfg, baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1" spellCheck={false}
            className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-11 text-ink-100" />
        </label>
        <label className="text-11 text-ink-300 flex flex-col gap-1">
          模型名
          <input value={cfg.model} onChange={e => setCfg({ ...cfg, model: e.target.value })}
            placeholder={TRANSCRIBE_DEFAULT_MODEL} spellCheck={false}
            className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-11 text-ink-100" />
        </label>
        <label className="text-11 text-ink-300 flex flex-col gap-1 sm:col-span-2">
          API Key
          <input value={cfg.apiKey} onChange={e => setCfg({ ...cfg, apiKey: e.target.value })}
            type="password" autoComplete="off" spellCheck={false} placeholder="只存在本机配置里"
            className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-11 text-ink-100" />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void save()}>保存转写配置</Button>
        {!ready && <span className="text-10 text-ink-500">填全三项后，灵感夹的「语音」才会亮起。</span>}
      </div>
    </Panel>
  )
}