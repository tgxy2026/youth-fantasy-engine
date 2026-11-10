// Keep author line breaks while rendering blank lines as compact paragraph spacing.
export default function ReadingText({ body, fontSize = 15 }: { body: string; fontSize?: number }) {
  const paragraphs = body.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n(?:[\t ]*\n)*/)
  return (
    <div className="space-y-2 break-words text-ink-200" style={{ fontSize: `${fontSize}px`, lineHeight: 1.75 }}>
      {paragraphs.map((paragraph, i) => <p className="whitespace-pre-wrap" key={i}>{paragraph}</p>)}
    </div>
  )
}
