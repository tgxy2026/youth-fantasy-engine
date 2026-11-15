// ============ 3.5.6 · MCP 长章节分段读取 ============
//
// 覆盖：
//  · 页面执行器与桌面只读桥的版本算法一致；
//  · 分段参数边界、游标与版本冲突；
//  · 只读桥真实调用（临时数据文件）：旧语义不变、分段可用、冲突可识别；
//  · 工具 schema 与开发者规范同步。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAPTER_RANGE_MAX_LIMIT, chapterVersion, parseChapterRange, sliceChapter, type ChapterRangeArgs } from '../src/lib/agentHost/chapterRange'
import { chapterVersionOf, createReadonlyTools } from '../scripts/agent-host/readonly-tools.mjs'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const text = `第一章 合成正文。${'春风又绿江南岸，明月何时照我还。'.repeat(40)}尾句。`
ok('页面与只读桥版本算法一致', chapterVersion(text) === chapterVersionOf(text), `${chapterVersion(text)} vs ${chapterVersionOf(text)}`)
ok('版本随内容变化', chapterVersion(text) !== chapterVersion(`${text}多一个字`))
ok('版本随长度变化', chapterVersion('a') !== chapterVersion('aa'))
ok('版本形状稳定', /^v1-\d+-[0-9a-f]+$/.test(chapterVersion(text)))

/** 断言解析成功并返回窄化后的类型（失败时直接抛，避免把错误当参数用）。 */
const asRange = (value: ReturnType<typeof parseChapterRange>): ChapterRangeArgs => {
  if ('error' in value) throw new Error(value.error)
  return value
}

const plain = asRange(parseChapterRange({}))
ok('不传范围 = 旧整章语义', plain.explicit === false)
const ranged = asRange(parseChapterRange({ offset: 5, limit: 20 }))
ok('范围参数解析', ranged.explicit === true && ranged.offset === 5 && ranged.limit === 20)
const limitOnly = asRange(parseChapterRange({ limit: 100 }))
ok('只给 limit 时 offset 默认 0', limitOnly.explicit === true && limitOnly.offset === 0)
ok('limit 上限内', asRange(parseChapterRange({ limit: CHAPTER_RANGE_MAX_LIMIT })).explicit === true)
ok('limit 超上限拒绝', 'error' in parseChapterRange({ limit: CHAPTER_RANGE_MAX_LIMIT + 1 }))
ok('limit 为 0 拒绝', 'error' in parseChapterRange({ limit: 0 }))
ok('offset 负数拒绝', 'error' in parseChapterRange({ offset: -1 }))
ok('offset 小数拒绝', 'error' in parseChapterRange({ offset: 1.5 }))
ok('expectedVersion 类型校验', 'error' in parseChapterRange({ offset: 0, expectedVersion: 123 }))
const withVersion = asRange(parseChapterRange({ offset: 0, expectedVersion: 'v1-1-a' }))
ok('expectedVersion 透传', withVersion.explicit === true && withVersion.expectedVersion === 'v1-1-a')

const mid = sliceChapter(text, 10, 5)
ok('中间片段正确', 'text' in mid && mid.text === text.slice(10, 15))
ok('中间片段游标', 'text' in mid && mid.range.nextOffset === 15 && mid.range.hasMore === true)
ok('中间片段带版本', 'text' in mid && mid.range.version === chapterVersion(text))
const tail = sliceChapter(text, text.length - 3, 100)
ok('末尾片段读尽', 'text' in tail && tail.text === text.slice(-3) && tail.range.hasMore === false)
const empty = sliceChapter(text, text.length, 10)
ok('正好读完返回空片段', 'text' in empty && empty.text === '' && empty.range.hasMore === false)
ok('offset 越界报错', 'error' in sliceChapter(text, text.length + 1, 10))

// ---------- 只读桥真实调用 ----------
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yfe-356-mcp-range-'))
try {
  const file = path.join(dir, 'data.json')
  fs.writeFileSync(file, JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 1,
    stores: {
      chapters: [{
        id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第一章', content: text,
        summary: '合成摘要', status: 'draft', wordCount: text.length, createdAt: 1, updatedAt: 2,
      }],
    },
  }))
  const tools = createReadonlyTools(file)
  const full = tools.invoke('yfe_read_chapter', { chapterId: 'c1' }) as Record<string, unknown>
  ok('旧调用仍返回整章', full.content === text && full.range === undefined)
  const part = tools.invoke('yfe_read_chapter', { chapterId: 'c1', offset: 3, limit: 7 }) as Record<string, unknown>
  const range = part.range as Record<string, unknown>
  ok('只读桥分段内容', part.content === text.slice(3, 10))
  ok('只读桥游标与版本', range.nextOffset === 10 && range.totalChars === text.length && range.version === chapterVersion(text))
  const again = tools.invoke('yfe_read_chapter', {
    chapterId: 'c1', offset: 3, limit: 7, expectedVersion: String(range.version),
  }) as Record<string, unknown>
  ok('版本一致可续读', again.content === text.slice(3, 10))
  assert.throws(
    () => tools.invoke('yfe_read_chapter', { chapterId: 'c1', offset: 3, limit: 7, expectedVersion: 'v1-0-x' }),
    /正文已变化/,
  )
  ok('版本不一致明确报错', true)
  assert.throws(() => tools.invoke('yfe_read_chapter', { chapterId: 'c1', offset: text.length + 1, limit: 5 }), /超出正文长度/)
  ok('只读桥 offset 越界报错', true)
} finally {
  await fsp.rm(dir, { recursive: true, force: true })
}

// ---------- 接线静态契约 ----------
const executor = read('src/lib/agentHost/executor.ts')
ok('执行器使用分段解析', executor.includes('parseChapterRange') && executor.includes('readChapterRange'))
ok('执行器版本冲突用 CONFLICT', executor.includes('parseChapterRange') && /CONFLICT[\s\S]{0,80}重新读取本章/.test(executor))
const agent = read('scripts/mcp/yfe-agent.mjs')
const chapterTool = agent.slice(agent.indexOf("name: 'yfe_read_chapter'"), agent.indexOf("name: 'yfe_check_chapter_words'"))
ok('随包 MCP schema 含分段参数', ['offset', 'limit', 'expectedVersion'].every(key => chapterTool.includes(key)))
ok('随包 MCP 说明游标', chapterTool.includes('nextOffset') && chapterTool.includes('hasMore'))
const bridge = read('scripts/agent-host/readonly-tools.mjs')
ok('只读桥支持分段', bridge.includes('parseChapterRangeArgs') && bridge.includes('nextOffset'))
const spec = read('docs/agent/MCP第三方开发者适配规范.md')
ok('开发者规范写明分段读取', spec.includes('长章节的分段读取') && spec.includes('expectedVersion'))

console.log(`\nMCP_CHAPTER_RANGE ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
