import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from '@/components/common/Button'
import { copyText } from '@/components/dialogs/dialogs'
import { summarizeFailure } from '@/lib/app/failureSummary'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { foldVh } from '@/lib/settings/theme'

/** This screen must work before project navigation, the data dock, or a database are ready. */
export default function FailureNotice({ title, description, error, actions, children, embedded = false }: {
  title: string; description: string; error: unknown; actions: ReactNode; children?: ReactNode; embedded?: boolean
}) {
  const Frame = embedded ? 'section' : 'main'
  const Heading = embedded ? 'h2' : 'h1'
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const summary = `青春幻想引擎 ${APP_VERSION_LABEL}\n${title}\n${summarizeFailure(error)}`
  return <Frame aria-labelledby={titleId} className="w-full flex items-center justify-center bg-surface-app p-6" style={{ minHeight: embedded ? '16rem' : foldVh('100vh') }}>
    <section className="w-full max-w-2xl rounded-xl border border-danger/30 bg-surface-panel p-5 shadow-xl">
      <Heading id={titleId} ref={heading} tabIndex={-1} className="text-lg font-semibold text-content-primary">{title}</Heading>
      <p className="mt-3 text-13 leading-relaxed text-content-secondary">{description}</p>
      {children && <div className="mt-3 text-12 leading-relaxed text-content-muted">{children}</div>}
      <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
      <details className="mt-5 border-t border-line-subtle pt-3 text-12 text-content-secondary">
        <summary className="cursor-pointer">查看技术摘要</summary>
        <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-app p-3 text-11 leading-relaxed">{summary}</pre>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => void copyText(summary, '技术摘要已复制')}>复制技术摘要</Button>
        <p className="mt-2 text-11 text-content-muted">仅复制上方摘要，不会自动上传。完整技术日志保留在本机控制台。</p>
      </details>
    </section>
  </Frame>
}
