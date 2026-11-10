// 投稿广场 · 界面小件（3.5.0）
//
// 只放「多个面板共用、且没有业务含义」的组件：状态条、错误条、字段壳、空态。
// 业务文案留在各自面板里，避免一个通用组件被迫懂审核状态。

import type { ReactNode } from 'react'

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const cls = kind === 'error'
    ? 'border-red-500/40 bg-red-500/10 text-ink-100'
    : kind === 'warn'
      ? 'border-amber/40 bg-amber/10 text-amber'
      : kind === 'ok'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-ink-100'
        : 'border-ink-700 bg-ink-900/70 text-ink-300'
  return <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-12 leading-relaxed ${cls}`}>{children}</p>
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-12 font-medium text-ink-100">{label}</label>
      {children}
      {hint && <p className="text-11 leading-relaxed text-ink-400">{hint}</p>}
    </div>
  )
}

export function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const cls = tone === 'ok'
    ? 'border-emerald-500/40 text-success'
    : tone === 'warn'
      ? 'border-amber/40 text-amber'
      : tone === 'bad'
        ? 'border-red-500/40 text-danger'
        : 'border-ink-700 text-ink-300'
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-11 ${cls}`}>{children}</span>
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-700 px-4 py-10 text-center">
      <p className="text-13 text-ink-200">{title}</p>
      {hint && <p className="mt-1 text-11 text-ink-400">{hint}</p>}
    </div>
  )
}

export function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
