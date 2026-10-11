/**
 * 酒馆模式 · 自由对话「故事 / 词条 / 剧本」的**文本导入导出**（同格式，可往返）
 *
 * 【为什么单独一个文件】解析是**纯逻辑**，界面只负责「搬运 + 确认」。
 * 把正确性压在这一层、用单测穷举，界面能出问题的面就小得多。
 *
 * 【格式为什么用 〖〗】
 * `〖〗` 是项目既有的**输入侧结构标记**（见 `prompt.ts` 顶部的「标记分域」纪律）：
 * 它**不是模型输出格式**（输出只有 `（ ）` 与 `〔 〕`），所以不会被学进正文；
 * 全角、显眼、**手写友好**（不用 JSON 转义、不用管缩进），AI 也天然照得出。
 *
 * 【三条硬约束（都是拍板定下的）】
 * ① **一次只导一个故事** —— 出现第二个 `〖故事〗` 直接报错，让作者分开导。
 *    落地语义是「导入即新建一个故事」，半路冒出第二个没地方放。
 * ② **只认这一套标记** —— 认不出来就如实报「第几行、缺什么」，**绝不猜**。
 * ③ **超上限如实报告** —— 由界面决定是截断还是让作者改，不静默吞掉。
 *
 * 【追加模式（2026-10-09）】
 * 同一份文本也能**追加进已有故事**（只补词条与剧本，见文件下半部分）。两条放宽 / 收紧：
 *   · 放宽：可以不写 `〖故事〗`（目标故事由界面选定，名字不必再抄一遍）；
 *   · 收紧：与目标故事里同名（或本份文本内自撞）的剧本 / 词条**当场拦下**，由作者改名后重来。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { STORY_NAME_MAX, STORY_SETTING_MAX, storyEntriesOf } from '@/lib/tavern/story'
import { uid } from '@/lib/app/id'
import { SCRIPT_FIELD_MAX } from '@/lib/tavern/script'
import { type WorldEntry, type EntryState, ENTRY_STATE_LABEL, emptyWorldEntry } from '@/lib/tavern/worldBook'
import type { ScriptDraftFields } from '@/lib/tavern/script'

/** 分节标记（与 __tests__ 的守护断言共用同一组常量，避免各处再抄一遍字面量） */
export const MARK = {
  story: '〖故事〗',
  setting: '〖世界设定〗',
  entry: '〖词条〗',
  script: '〖剧本〗',
} as const

/** 剧本六栏的键名（顺序即渲染顺序）。名称单独一行（跟在 〖剧本〗 后） */
export const SCRIPT_KEYS: { key: keyof ScriptDraftFields; label: string }[] = [
  { key: 'situation', label: '情境' },
  { key: 'opening', label: '开场白' },
  { key: 'playerRole', label: '你的位置' },
  { key: 'goal', label: '这一场的目标' },
  { key: 'taboo', label: '不要发生' },
]

/** 词条块里的键行（`状态` 可写 常驻/触发/引荐/休眠；不写就按触发词推断） */
const ENTRY_KEY_LABELS = ['触发', '概率', '顺序', '状态', '正文'] as const

export type DraftEntry = {
  title: string
  body: string
  keys: string[]
  prob: number
  order: number
  recursive: boolean
  state?: EntryState
}

export type ParsedStoryImport = {
  /** 故事名（缺省时为空串 —— 界面可回退成「未命名故事」） */
  storyName: string
  setting: string
  entries: DraftEntry[]
  scripts: ScriptDraftFields[]
}

export type ImportIssue = {
  level: 'error' | 'warn'
  /** 出问题的行号（1 基；整篇级问题不带） */
  line?: number
  message: string
}

export type ParseResult =
  | { ok: true; data: ParsedStoryImport; issues: ImportIssue[] }
  | { ok: false; issues: ImportIssue[] }

export type ParseOptions = {
  /**
   * 追加模式专用：**允许不写 `〖故事〗`**（2026-10-09）。
   *
   * 追加时目标故事由界面选定，文本里的故事名只是参考 —— 强制要求写它，作者会困惑
   * 「我都要追加到 A 了，为什么还要再抄一遍故事名」。新建模式仍强制（那才是落地名字的来源）。
   * ⚠️ 「一份文本只能有一个 `〖故事〗`」这条**两种模式下都成立**：半路冒出第二块仍然没地方放。
   */
  allowNoStoryName?: boolean
}

/** 给作者复制的模板（也用于「导入格式说明」；改格式时这里是唯一真源） */
export const IMPORT_TEMPLATE = `${MARK.story}

${MARK.setting}

${MARK.entry}
触发：
正文：

${MARK.script}
情境：
开场白：
你的位置：
这一场的目标：
不要发生：`

/** 归一化：剥 BOM、CRLF→LF（Windows 复制粘贴最常见的不一致） */
function normalize(text: string): string {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 触发词分隔：中英文逗号、顿号、分号都认 */
function splitKeys(v: string): string[] {
  return v.split(/[、,，;；]/).map(s => s.trim()).filter(Boolean)
}

/** 四色灯的中文名 → 内部值（认不出返回 undefined，不猜） */
function parseState(v: string): EntryState | undefined {
  const t = v.trim()
  for (const [k, label] of Object.entries(ENTRY_STATE_LABEL) as [EntryState, string][]) {
    if (label === t) return k
  }
  return undefined
}

/** 一行是不是 `某键：值`（返回键与值；不是则 key 为 null） */
function splitKeyLine(line: string, labels: readonly string[]): { key: string | null; value: string } {
  const m = /^([^：:]{1,8})[：:]\s?([\s\S]*)$/.exec(line)
  if (!m) return { key: null, value: line }
  const k = m[1].trim()
  return labels.includes(k) ? { key: k, value: m[2] } : { key: null, value: line }
}

/**
 * 解析导入文本。**只认标记**，认不出来如实报错。
 */
export function parseStoryImport(raw: string, opts: ParseOptions = {}): ParseResult {
  const text = normalize(raw)
  const lines = text.split('\n')

  const issues: ImportIssue[] = []
  const storyNames: { line: number; name: string }[] = []
  const entries: DraftEntry[] = []
  const scripts: ScriptDraftFields[] = []

  let setting = ''
  /** 当前块：'none' 还没进任何块 / 'setting' 世界设定 / 'entry' 词条 / 'script' 剧本 */
  let block: 'none' | 'setting' | 'entry' | 'script' = 'none'
  let curEntry: DraftEntry | null = null
  let curScript: ScriptDraftFields | null = null
  /** 剧本块里「最后一个键」—— 裸行续写到它（这样多行值不用反复写键名） */
  let lastScriptKey: keyof ScriptDraftFields | null = null

  /** 收尾一个词条：**空的丢掉**（粘模板时〖词条〗后面什么都没写，不该留下一堆空条目） */
  const flushEntry = () => {
    if (curEntry && (curEntry.title.trim() || curEntry.body.trim())) entries.push(curEntry)
    curEntry = null
  }
  /** 收尾一份剧本：六栏全空同样丢掉 */
  const flushScript = () => {
    if (curScript && SCRIPT_KEYS.some(k => String(curScript![k.key] ?? '').trim())) scripts.push(curScript)
    curScript = null
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i]

    // ---------- 分节标记 ----------
    if (line.startsWith(MARK.story)) {
      storyNames.push({ line: lineNo, name: line.slice(MARK.story.length).trim() })
      block = 'none'
      curEntry = null
      curScript = null
      continue
    }
    if (line.trim() === MARK.setting) { block = 'setting'; flushEntry(); flushScript(); continue }
    if (line.startsWith(MARK.entry)) {
      flushEntry()
      curEntry = {
        title: line.slice(MARK.entry.length).trim(),
        body: '', keys: [], prob: 1, order: 0, recursive: true,
      }
      block = 'entry'
      curScript = null
      continue
    }
    if (line.startsWith(MARK.script)) {
      flushEntry()
      flushScript()
      curScript = { name: line.slice(MARK.script.length).trim(), situation: '', opening: '', playerRole: '', goal: '', taboo: '' }
      block = 'script'
      lastScriptKey = null
      continue
    }

    // ---------- 块内 ----------
    if (block === 'setting') {
      // 世界设定：整段原样收（保留空行的段落感），尾部统一 trim
      setting += (setting ? '\n' : '') + line
      continue
    }

    if (block === 'entry' && curEntry) {
      const { key, value } = splitKeyLine(line, ENTRY_KEY_LABELS)
      if (key === '触发') { curEntry.keys = splitKeys(value); continue }
      if (key === '概率') {
        const n = Number(value.trim())
        if (Number.isFinite(n)) curEntry.prob = Math.min(1, Math.max(0, n))
        else issues.push({ level: 'warn', line: lineNo, message: `概率不是数字，已按 1 处理：${value.trim() || '(空)'}` })
        continue
      }
      if (key === '顺序') {
        const n = Number(value.trim())
        if (Number.isFinite(n)) curEntry.order = Math.trunc(n)
        else issues.push({ level: 'warn', line: lineNo, message: `顺序不是数字，已按 0 处理：${value.trim() || '(空)'}` })
        continue
      }
      if (key === '状态') {
        const st = parseState(value)
        if (st) curEntry.state = st
        else issues.push({ level: 'warn', line: lineNo, message: `状态认不出来（只认 常驻/触发/引荐/休眠），已忽略：${value.trim() || '(空)'}` })
        continue
      }
      if (key === '正文') { curEntry.body += (curEntry.body ? '\n' : '') + value; continue }
      // 裸行（或未知的 `xx：`）—— 原样并入正文，不丢字
      if (line.trim()) curEntry.body += (curEntry.body ? '\n' : '') + line
      continue
    }

    if (block === 'script' && curScript) {
      const { key, value } = splitKeyLine(line, SCRIPT_KEYS.map(k => k.label))
      const hit = key ? SCRIPT_KEYS.find(k => k.label === key) : undefined
      if (hit) {
        curScript[hit.key] += (curScript[hit.key] ? '\n' : '') + value
        lastScriptKey = hit.key
        continue
      }
      if (!line.trim()) continue
      if (lastScriptKey) {
        // 续写到上一个键（多行值）。
        // 🔴 该键还是**空的**就不加前导换行 —— 模板里 `开场白：` 独占一行、内容写在下一行，
        //    无条件拼 `'\n' + line` 会让开场白本身以换行开头（导入后第一行是空白行）。
        //    与命中分支（`hit` 那一支）用同一套「非空才补分隔符」的逻辑，保持一致。
        curScript[lastScriptKey] += (curScript[lastScriptKey] ? '\n' : '') + line
      } else {
        issues.push({ level: 'warn', line: lineNo, message: `剧本里的这行没归到任何一栏（缺「情境：」这类键名），已忽略：${line.slice(0, 30)}` })
      }
      continue
    }

    // 块外的裸行：允许留白与注释式文字，但**有内容就提醒**
    if (line.trim() && block === 'none') {
      // 标记之前的开场白允许（很多人会写一句说明），只在「非空且不像说明」时轻提示
      // —— 这里不报错：模板允许作者在开头写一两句自己的话。
      if (!/^[（(【\[]/.test(line.trim())) {
        issues.push({ level: 'warn', line: lineNo, message: `这行不在任何分节里，已忽略：${line.slice(0, 30)}` })
      }
    }
  }

  flushEntry()
  flushScript()

  // ---------- 校验 ----------
  if (storyNames.length === 0) {
    // 追加模式下故事名不是必填（目标故事由界面选定，见 ParseOptions 的注释）
    if (!opts.allowNoStoryName) {
      issues.push({
        level: 'error',
        message: `没找到故事名 —— 第一行要写成「${MARK.story}故事名」。请按模板导入。`,
      })
    }
  } else if (storyNames.length > 1) {
    issues.push({
      level: 'error',
      line: storyNames[1].line,
      message: `这份文本里有 ${storyNames.length} 个故事（第 ${storyNames[1].line} 行是第二个）。`
        + '一次只能导入一个故事 —— 请把每个故事拆成单独的文件分别导入。',
    })
  }

  const storyName = (storyNames[0]?.name ?? '').trim()
  const settingTrim = setting.trim()

  if (storyNames.length === 1 && !storyName) {
    issues.push({ level: 'warn', message: `「${MARK.story}」后面没写故事名，保存时会用「未命名故事」。` })
  }

  if (!settingTrim && entries.length === 0 && scripts.length === 0) {
    issues.push({ level: 'error', message: '除了故事名之外什么都没读到 —— 至少要有一段世界设定、一个词条或一份剧本。' })
  }

  if (storyName.length > STORY_NAME_MAX) {
    issues.push({ level: 'warn', message: `故事名超过 ${STORY_NAME_MAX} 字，保存时会截断到 ${STORY_NAME_MAX} 字。` })
  }
  if (settingTrim.length > STORY_SETTING_MAX) {
    issues.push({
      level: 'warn',
      message: `世界设定 ${settingTrim.length} 字，超过 ${STORY_SETTING_MAX} 字上限，保存时会截断。`
        + '建议精简，或拆成带触发词的「词条」（那样按命中注入，不占固定额度）。',
    })
  }
  entries.forEach((e, idx) => {
    if (!e.title.trim()) issues.push({ level: 'warn', message: `第 ${idx + 1} 个词条没有名字（${
      MARK.entry} 后面直接跟名字）。` })
  })
  scripts.forEach((s, idx) => {
    for (const { key, label } of SCRIPT_KEYS) {
      const v = (s[key] ?? '').trim()
      const max = SCRIPT_FIELD_MAX[key as keyof typeof SCRIPT_FIELD_MAX]
      if (max && v.length > max) {
        issues.push({ level: 'warn', message: `第 ${idx + 1} 份剧本（${s.name || '未命名'}）的「${label}」${v.length} 字，超过 ${max} 字，保存时会截断。` })
      }
    }
  })

  if (issues.some(x => x.level === 'error')) return { ok: false, issues }

  return {
    ok: true,
    data: { storyName, setting: settingTrim, entries, scripts },
    issues,
  }
}

/** 结构 → 文本（与 parse 同格式，导出后能原样导回来） */
export function serializeStoryImport(src: {
  name: string
  setting: string
  entries: WorldEntry[]
  scripts: ScriptDraftFields[]
}): string {
  const out: string[] = []
  out.push(`${MARK.story}${src.name.trim() || '未命名故事'}`)

  const setting = (src.setting ?? '').trim()
  if (setting) out.push('', MARK.setting, setting)

  for (const e of src.entries ?? []) {
    out.push('', `${MARK.entry}${(e.title ?? '').trim() || '（未命名词条）'}`)
    if (e.keys?.length) out.push(`触发：${e.keys.join('、')}`)
    if (typeof e.prob === 'number' && e.prob !== 1) out.push(`概率：${e.prob}`)
    if (typeof e.order === 'number' && e.order !== 0) out.push(`顺序：${e.order}`)
    // 只导出「与推断结果不同」的状态：触发/常驻由触发词推得，写出来纯属噪音
    const st: EntryState = e.state
      ?? (e.constant ? 'on' : (e.keys?.length ? (e.recursive === false ? 'ref' : 'hit') : 'on'))
    if (st !== 'hit' && st !== 'on') out.push(`状态：${ENTRY_STATE_LABEL[st]}`)
    if ((e.body ?? '').trim()) out.push(`正文：${e.body.trim()}`)
  }

  for (const s of src.scripts ?? []) {
    out.push('', `${MARK.script}${(s.name ?? '').trim() || '（未命名剧本）'}`)
    for (const { key, label } of SCRIPT_KEYS) {
      const v = ((s as Record<string, unknown>)[key] as string ?? '').trim()
      if (v) out.push(`${label}：${v}`)
    }
  }

  return out.join('\n') + '\n'
}

// ============================================================
// 追加到已有故事（老大 2026-10-09 拍板）
// ============================================================

/**
 * 【两条拍板，别改】
 *   ① **世界设定不改** —— 文本里的 `〖世界设定〗` 一律**忽略**。已有故事的世界观是它自己的，
 *      从别处复制来的那份并进去只会让两份设定打架（同一件事两种说法）。界面要如实写出来。
 *   ② **重名当场拦下** —— 撞上目标故事里已有的剧本 / 词条名字，直接报错、不导入，由作者改名重来。
 *      自动加序号会悄悄造出一个他没写过的名字，列表里还更难分辨 —— 宁可打断一次，也不替作者改名。
 *
 * 另一条必要的兜底在 `entriesToAppend`：老形态故事（只有整段 `setting`）被追加词条时，
 * 必须先把那段设定搬成一条常驻词条，否则它会**静默失效**（判据见下）。
 */

export type AppendConflict = {
  kind: 'script' | 'entry'
  /** 撞上的名字（trim 过的原文） */
  name: string
  /**
   * 撞在哪儿：
   *   `existing` = 目标故事里已有同名（改个名就能导）；
   *   `self`     = 这份文本自己前后重名（文本里就有两份）。
   * 两种都要拦 —— 落地后都是列表里两份同名的东西。
   */
  from: 'existing' | 'self'
}

/** 目标故事里已经占着的名字（由界面读库后传进来；纯函数只负责比对） */
export type AppendExisting = {
  scriptNames: string[]
  entryTitles: string[]
}

/**
 * 找出「追加到已有故事」会被拦下的重名项。
 *
 * ⚠️ **空名字不参与比对** —— 没写名的剧本 / 词条在列表里本来就允许并存，
 *    拿它当冲突会把「模板没填完」误报成一堆重名。
 */
export function findAppendConflicts(
  incoming: Pick<ParsedStoryImport, 'entries' | 'scripts'>,
  existing: AppendExisting,
): AppendConflict[] {
  const out: AppendConflict[] = []

  const scan = (kind: AppendConflict['kind'], names: string[], taken: string[]) => {
    const exist = new Set(taken.map(n => n.trim()).filter(Boolean))
    const seen = new Set<string>()
    for (const raw of names) {
      const name = String(raw ?? '').trim()
      if (!name) continue
      if (exist.has(name)) { out.push({ kind, name, from: 'existing' }); continue }
      if (seen.has(name)) { out.push({ kind, name, from: 'self' }); continue }
      seen.add(name)
    }
  }

  scan('script', incoming.scripts.map(s => s.name), existing.scriptNames)
  scan('entry', incoming.entries.map(e => e.title), existing.entryTitles)
  return out
}

/** 冲突的一句话说明（界面直接显示，避免两边各写一套文案） */
export function conflictText(c: AppendConflict): string {
  const what = c.kind === 'script' ? '剧本' : '词条'
  return c.from === 'existing'
    ? `${what}「${c.name}」与目标故事里已有的同名 —— 请改名后再追加`
    : `${what}「${c.name}」在这份文本里出现了两次 —— 请改名后再追加`
}

/**
 * 目标故事是不是「整段世界设定」的老形态 —— 追加词条会把它搬成词条，界面须提前告知作者。
 * （判据与 `storyEntriesOf` 一致：没有 entries 但写了 setting。）
 */
export function willMigrateSetting(story: { setting?: string; entries?: WorldEntry[] } | null | undefined): boolean {
  if (!story) return false
  return !(Array.isArray(story.entries) ? story.entries : []).length && !!String(story.setting ?? '').trim()
}

/**
 * 追加词条时，目标故事的**新词条池**：现有池 + 本次导入的词条。
 *
 * 🔴 **为什么不能直接 `[...story.entries, ...新增]`**：`storyEntriesOf` 的判据是
 *    「有 `entries` 就以它为准、`setting` 被忽略」。老故事只有 `setting`（整段形态），
 *    一旦被写上 entries，那段设定就**静默失效** —— 世界观当场消失，还不报任何错。
 *    所以这里统一走 `storyEntriesOf`：老形态会先退化成一条常驻词条（id 沿用
 *    `STORY_SETTING_ID`，继续按固定层每轮注入，与升级前的注入结果等价），再往后接新词条。
 *
 * 新词条的 id 在这里生成（调用方不必自己管）—— 漏给 id 会让两条词条同名同 id，
 * 「删一条」会把另一条也带走。
 */
export function entriesToAppend(
  story: { setting?: string; entries?: WorldEntry[] },
  entries: DraftEntry[],
): WorldEntry[] {
  const base = storyEntriesOf(story)
  return [...base, ...entries.map(e => draftEntryToWorldEntry(e, uid()))]
}

/** 解析出的词条草稿 → 落库用的世界书词条（补 id、空名给占位、state 没写就不写这个键） */
export function draftEntryToWorldEntry(e: DraftEntry, id: string): WorldEntry {
  const out: WorldEntry = {
    ...emptyWorldEntry(),
    id,
    title: e.title.trim() || '（未命名词条）',
    body: e.body,
    keys: e.keys,
    prob: e.prob,
    order: e.order,
    recursive: e.recursive,
  }
  // 🔴 只在解析出状态时才带这个键 —— 没写状态的词条按老语义推断（见 `entryStateOf`），
  //    写成 `state: undefined` 会让「显式设过状态」与「没设过」在落盘后来回漂移。
  if (e.state) out.state = e.state
  return out
}
