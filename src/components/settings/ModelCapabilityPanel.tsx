/**
 * 3.3.3 · A3：「能力来源与诊断」面板（模型设置里）。
 *
 * 只展示 + 触发一次实测；判定全在 `capabilityProfile.ts`（纯逻辑）与 `capabilityTest.ts`（网络）。
 * 🔴 文案必须说清「本次实际采用什么、来源是什么、下一步做什么」；
 *    不出现"模型不支持 X"这类由一次失败推导出来的结论。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, Loader2, ShieldQuestion, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import type { AIProvider } from '@/lib/aiCore/core'
import { capabilitiesOf } from '@/lib/ai/modelCapabilities'
import {
  capabilityConfigFingerprint, describeCapability, getCachedCapability, hydrateCapabilityTests,
  loadCapabilityTests, persistCapabilityTest, type CapabilityTestRecord,
} from '@/lib/ai/capabilityProfile'
import { CAPABILITY_TEST_TIMEOUT_MS, testModelCapability } from '@/lib/ai/capabilityTest'

export default function ModelCapabilityPanel({
  providers,
  activeId,
}: {
  providers: AIProvider[]
  activeId: string | null
}) {
  const provider = useMemo(
    () => providers.find(p => p.id === activeId) ?? providers[0] ?? null,
    [providers, activeId],
  )
  const [hydrated, setHydrated] = useState(false)
  const [test, setTest] = useState<CapabilityTestRecord | null>(null)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const records = await loadCapabilityTests()
      hydrateCapabilityTests(records)
      if (alive) setHydrated(true)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => { abortRef.current?.abort() }, [provider?.id])

  const caps = useMemo(
    () => (provider ? capabilitiesOf(provider.model, provider, provider.baseUrl, capabilityConfigFingerprint(provider)) : null),
    [provider],
  )
  useEffect(() => {
    if (!provider) { setTest(null); return }
    setTest(getCachedCapability({
      endpoint: provider.baseUrl, modelId: provider.model, protocol: provider.type,
      configFingerprint: capabilityConfigFingerprint(provider),
    }))
    setOutcome('')
  }, [provider, hydrated])

  const diagnosis = useMemo(() => (caps ? describeCapability(caps, test) : null), [caps, test])

  const runTest = async () => {
    if (!provider) return
    const ok = await confirmDialog({
      title: '实测这个模型的能力',
      message: `会向当前端点发 1 次很小的 JSON 请求（可能产生少量费用），最多等 ${Math.round(CAPABILITY_TEST_TIMEOUT_MS / 1000)} 秒，可随时取消。\n\n`
        + '只记录"这次端点是否可用 / 回答能否解析成 JSON 对象"，不保存密钥，也不因此判定模型"支持/不支持 schema"。',
      confirmText: '开始实测',
    })
    if (!ok) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    setOutcome('')
    try {
      const r = await testModelCapability({ provider, signal: ctrl.signal })
      setOutcome(r.message)
      if (r.record) {
        await persistCapabilityTest(r.record)
        setTest(r.record)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '实测失败', 'error')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  if (!provider) return null

  return (
    <section className="mt-3 rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldQuestion size={13} className="text-ink-400" />
        <span className="text-12 text-ink-200">能力来源与诊断</span>
        <span className="text-10 text-ink-500 font-mono truncate">{provider.model || '（未设置模型）'}</span>
        <div className="ml-auto flex items-center gap-2">
          {running && (
            <Button variant="secondary" size="xs" onClick={() => abortRef.current?.abort()}>
              <X size={11} /> 取消
            </Button>
          )}
          <Button variant="secondary" size="xs" disabled={running} onClick={() => void runTest()}>
            {running ? <><Loader2 size={11} className="animate-spin" /> 实测中…</> : <><FlaskConical size={11} /> 实测一次</>}
          </Button>
        </div>
      </div>

      {diagnosis && (
        <div className="mt-1.5 grid gap-1 text-10 text-ink-400 sm:grid-cols-2">
          <span>来源：<b className="text-ink-200">{diagnosis.sourceLabel}</b></span>
          <span>结构格式：<b className="text-ink-200">{diagnosis.structuredOutput === 'none' ? '只靠提示词约束' : diagnosis.structuredOutput}</b></span>
          <span>JSON 对象：{diagnosis.jsonOutput ? '可尝试' : '未确认'}{diagnosis.reasoningWithStructure ? ' · 推理+结构已确认' : ' · 推理+结构未确认'}</span>
          <span>实测：{test
            ? `${new Date(test.at).toLocaleString('zh-CN')} · ${test.jsonObject ? '能解析 JSON 对象' : '未确认 JSON 对象'} · schema 未测`
            : '未测（不影响普通任务；只是不能据此下发结构格式）'}</span>
        </div>
      )}

      {diagnosis && <p className="mt-1.5 text-10 leading-relaxed text-ink-500">{diagnosis.explain}</p>}
      {outcome && <p className="mt-1.5 rounded border border-ink-700 bg-ink-900/50 px-2 py-1 text-10 text-ink-300">{outcome}</p>}
      <p className="mt-1.5 text-10 leading-relaxed text-ink-600">
        实测会真实调用模型、可能计费；可跳过、超时、取消，不是使用前必经步骤。结论按「端点 + 模型 + 协议 + 配置」隔离，换端点或改配置后需重测。
      </p>
    </section>
  )
}