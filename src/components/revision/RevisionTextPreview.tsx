/** Full original text stays available without expanding every large candidate on entry. */
export default function RevisionTextPreview({ before, after }: { before: string; after: string }) {
  return <details className="mt-3 rounded-lg border border-ink-700 px-3 py-2">
    <summary className="cursor-pointer text-11 text-ink-200">审阅完整原文与候选</summary>
    <p className="mt-2 text-10 text-ink-500">此处只供审阅；展开、收起均不会写入正文。应用会替换整章，不支持在此部分采用。</p>
    {([['生成时原文', before], ['候选全文', after]] as const).map(([label, text]) => <section key={label} className="mt-3 min-w-0">
      <h3 className="text-11 font-medium text-ink-300">{label}</h3>
      <pre tabIndex={0} role="region" aria-label={label} className="mt-1 max-h-64 overflow-y-auto rounded bg-ink-950/50 p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-11 leading-relaxed text-ink-200 font-sans">{text}</pre>
    </section>)}
  </details>
}
