import type { CreativeWritingResult } from '@/lib/ai/aiWorkflow'
import type { CreativeResultSummary } from '@/lib/creative/creativeSession'

export function summarizeResult(res: CreativeWritingResult): CreativeResultSummary {
  return {
    mode: res.mode,
    bibleTotal: res.bible?.stats.total ?? 0,
    bibleCreated: res.bibleCommit?.created ?? 0,
    volumes: res.outline?.volumes.length ?? 0,
    outlineChapters: res.outline?.chapters.length ?? 0,
    wrote: res.chapters.length,
    outlineOnly: res.outlineOnly,
  }
}
