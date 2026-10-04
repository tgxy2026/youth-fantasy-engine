// AI 返回文本的解析与兜底 —— 全项目唯一入口。
//
// 为什么要有这个模块（2026-09-14 审计 P1-2）：
//   此前「解析模型输出」这件事被复制成了三份，且行为互相不一致——
//     ① aiTasks.ts 的 parseObjectArray —— 最完整（剥代码块 + 切最外层 + 单对象/数组归一化）
//     ② ai.ts 的 parseTemplateJSON —— 自己又写了一遍剥代码块与切片
//     ③ autoContinue.ts 的 extractSettingUpdates —— **裸 JSON.parse**，不剥代码块也不切最外层
//   结果是同一类模型输出（外面裹一层解释、或藏在 ```json 里）在不同任务里
//   有的能解析、有的整条丢弃，且失败彼此不可预期。现统一到这里。
//
// 约定：任何「把模型文本变成结构化数据」的地方都必须走本模块，不要再手写 JSON.parse。

/** 剥掉 markdown 代码块围栏（```json ... ``` / ``` ... ```） */
export function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
}

/** 剥围栏后截取最外层 JSON 片段（从首个 open 到最后一个 close） */
function sliceJSON(raw: string, open: '[' | '{'): string {
  const close = open === '[' ? ']' : '}'
  let s = stripCodeFence(raw)
  const a = s.indexOf(open)
  const b = s.lastIndexOf(close)
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return s
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** 归一化一次解析结果：数组→过滤出对象；单个对象→包成单元素数组（兼容 {list:[…]}）；其余→null */
function normalizeParsed(v: unknown): Record<string, unknown>[] | null {
  const onlyObjects = (arr: unknown[]) =>
    arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
  if (Array.isArray(v)) return onlyObjects(v)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    // {list:[…]} / {data:[…]}：优先取内部数组
    const inner = Object.values(o).find(x => Array.isArray(x))
    if (Array.isArray(inner)) return onlyObjects(inner)
    return [o]
  }
  return null
}

/**
 * 解析出**单个 JSON 对象**；失败返回 null。
 * 用于「模型应返回一个对象」的任务（如按键填表、设定更新）。
 */
export function parsePlainObject(raw: string): Record<string, unknown> | null {
  const v = tryParse(sliceJSON(raw, '{'))
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  // 兜底：模型把对象包在数组里（[{...}]）时也接受首元素
  const arr = tryParse(sliceJSON(raw, '['))
  if (Array.isArray(arr)) {
    const first = arr.find(x => !!x && typeof x === 'object' && !Array.isArray(x))
    if (first) return first as Record<string, unknown>
  }
  return null
}

/**
 * 剥掉 JSON **结构位置**（字符串字面量之外）上的杂散标点，并清掉尾随逗号。
 *
 * 为什么需要（2026-09-18 实机抓到）：小模型（qwen3:4b 实测）会在属性之间多写一个中文顿号 ——
 *   `"realm": "碎境巅峰", 、 "faction": "夜渊会"` → `JSON.parse` 直接死在 position 677。
 *   模型自己不知道这类瑕疵，而整批结果会全丢（表现为"生成成功但 0 条"，极难排查）。
 *
 * 做法：逐字符扫描、跟踪"是否在字符串内"（含转义），**只在字符串外**丢弃全角标点；
 *   字符串内部的顿号/句号是正常内容，绝不能动（否则会把描写句子改坏）。
 */
export function stripStrayPunct(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '、' || ch === '，' || ch === '；' || ch === '。') continue
    out += ch
  }
  // 连续逗号 → 一个；对象/数组闭合前的尾随逗号 → 去掉
  return out.replace(/,(?=\s*,)/g, '').replace(/,(\s*[}\]])/g, '$1')
}

/**
 * 解析**被截断的 JSON** —— 模型输出到一半自己停住（长上下文里尤其常见）。
 *
 * 【为什么必须单独有这一手（2026-09-18 创意写作实机抓到）】
 * 本地 27B 产分卷大纲时，原始返回长这样（**结尾少一个外层 `}`**）：
 *   `{"volumes":[…],"chapters":[{…,"scenes":["…","…"]}]`
 * `parsePlainObject` / `parseLooseObject` 都要求结构完整，于是整批**全丢**，
 * 上游表现为「生成成功但 0 章」；而 `aiGenerateOutline` 的重试用的是同一份 prompt，
 * 于是**断在同一处、连试两次都失败**（实机就是 86 秒后报"模型没有产出章节细纲"）。
 * 但内容前面 95% 都是好的 —— 为一个收尾括号丢掉全部产出，代价完全不成比例。
 *
 * 【三级让步，但绝不编造】
 *   ① 原文直接解析；
 *   ② 补上未闭合的括号（截断在字符串中时先补引号、去掉悬挂的 `,` / `:`）后解析；
 *   ③ 从尾部回退到最近一个**字符串外**的断点（`,` / `}` / `]`），再补全解析 ——
 *      丢掉被截断的那一条，保住前面的。截断常常停在 `"字段":` 或 `"字段":"写了一半`，
 *      这时只有从逗号处回退才救得回来。
 * 🔴 只做「修剪 + 补齐」：不补值、不改键名、不猜字段。宁可少一条，不可造一条。
 *
 * @returns 解析结果（对象或数组）；彻底救不回来时返回 null（调用方照旧走失败分支）
 */
export function parseTruncatedJson(raw: string): unknown {
  const base = stripCodeFence(raw).trim()
  if (!base || (base[0] !== '{' && base[0] !== '[')) return null
  // 除括号与空白外什么都没写 → 没有可救的内容。
  // 🔴 不能把 `{` "修复"成 `{}` —— 那会让调用方以为"解析成功、只是字段为空"，
  //    把"输出被掐断"这种必须报出来的事，伪装成一次正常的空结果。
  if (!/[^\s{}[\]]/.test(base)) return null

  const direct = tryParse(base)
  if (direct !== null) return direct

  const closed = tryParse(closeBrackets(base))
  if (closed !== null) return closed

  // 回退到最近的断点再补全。限步数：几 KB 的文本最多试 400 个候选，耗时可控。
  const breaks = structuralBreaks(base)
  const limit = Math.max(0, breaks.length - 400)
  for (let k = breaks.length - 1; k >= limit; k--) {
    // 断在逗号 → 从逗号**之前**切（丢弃它后面那条残缺的）；断在 } / ] → 含它一起切
    const at = breaks[k]
    const cut = base[at] === ','
      ? base.slice(0, at)
      : base.slice(0, at + 1).replace(/,\s*$/, '')
    const v = tryParse(closeBrackets(cut))
    if (v !== null) return v
  }
  return null
}

/** 补齐未闭合的括号；截断停在字符串内时先补引号，并去掉悬挂的 `,` / `:` */
function closeBrackets(s: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = inStr ? s + '"' : s
  out = out.replace(/[,:]\s*$/, '')
  return out + stack.reverse().join('')
}

/** **字符串之外**的断点位置（`,` / `}` / `]`）；字符串里的同名字符不算 */
function structuralBreaks(s: string): number[] {
  const out: number[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === ',' || ch === '}' || ch === ']') out.push(i)
  }
  return out
}

/**
 * **宽松**解析单个 JSON 对象：先走严格路径（`parsePlainObject`），失败再清掉结构位的
 * 杂散标点与尾随逗号重试，最后兜底**截断修复**。
 *
 * ⚠️ 刻意**不改** `parsePlainObject` 本身 —— 它被全项目 20+ 处复用，改变其容错边界属于
 * "静默扩大接受范围"，风险大于收益。生成型入口（`aiGenerateBible` / `aiGenerateOutline`）
 * 输出规模大、模型更易出格式瑕疵，故单独用本函数。
 */
export function parseLooseObject(raw: string): Record<string, unknown> | null {
  const strict = parsePlainObject(raw)
  if (strict) return strict
  const v = tryParse(stripStrayPunct(sliceJSON(raw, '{')))
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  // 末级兜底：结构被截断（少收尾括号）时修剪 + 补齐再试 —— 否则前面全部内容白丢
  const repaired = parseTruncatedJson(raw)
  return repaired && typeof repaired === 'object' && !Array.isArray(repaired)
    ? (repaired as Record<string, unknown>)
    : null
}

/**
 * 解析「对象数组」。模型偶尔返回单个对象或 {list:[…]}，一并兼容。
 *
 * ⚠️ 修复（2.0.1）：原实现先按 '[' 切片，若 raw 本身就是**单个 JSON 对象**，
 *    sliceJSON 找不到 '[' 会原样返回，JSON.parse 于是成功解析出一个**非数组对象**；
 *    此时 `v` 为真值 → 跳过兜底分支 → 末尾 `Array.isArray(v)` 为 false → **return []**。
 *    结果是所有「单对象」返回的内容全部丢失，调用方只能退到 humanText 兜底，
 *    表现为「润色/扩写只输出个别标点符号」。现改为：数组与单对象两种形态都归一化后再取。
 *   🔴 请勿退回「先按 '[' 切片再判数组」的老写法。
 */
export function parseObjectArray(raw: string): Record<string, unknown>[] {
  const arr = normalizeParsed(tryParse(sliceJSON(raw, '[')))
  if (arr && arr.length > 0) return arr
  const obj = normalizeParsed(tryParse(sliceJSON(raw, '{')))
  if (obj && obj.length > 0) return obj
  // 末级兜底：结构被截断时修剪 + 补齐 —— 抽取任务一次要吐十几条，
  // 最后一条被截断就会让整批解析失败（保住前 N-1 条也远好过全丢）
  const repaired = normalizeParsed(parseTruncatedJson(raw))
  if (repaired && repaired.length > 0) return repaired
  return []
}

/**
 * 兜底文本是否还有实质内容：排除「只剩标点/符号」的残骸，避免把垃圾塞给作者。
 *
 * ⚠️ 当前的实际适用范围（2026-09-14 核对，勿凭空假设它已全局生效）：
 *   目前**只有 aiTasks 的 aiRewritePassage 一处**调用它（改稿任务，怕把标点残骸当正文回填）。
 *   其余约 10 处 `humanText(text) || ...` 兜底（各 summary/verdict/direction/report 类任务）
 *   **并未**过滤——即解析失败且残骸只剩标点时，那些路径仍会把残骸交给 UI。
 *   是否要一并过滤属**用户可见行为变更**（"空白"与"残渣"哪个体验更好）需产品决策，
 *   故此处只如实说明现状，未擅自推广。若决定推广，请连同回归测试一起改。
 */
export function hasSubstance(s: string): boolean {
  const stripped = s.replace(/[\s\d\p{P}\p{S}]/gu, '')
  return stripped.length >= 4
}

/** 把模型给的任意标量/数组值安全转成展示文本 */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('、')
  return ''
}

/**
 * 模型文本兜底清洗（v1.6）：JSON 解析失败时不能把原始文本（含键名 json/level/action/rewritten…）直接展示。
 * - 若文本含 JSON：按 `"键":"值"` 成对提取所有「值」，还原 \n 换行。
 * - 否则：剥掉散落的 JSON 符号与带引号的键名残余。
 *
 * ⚠️ 修复（2026-09-14）：旧实现用 /"((?:[^"\\]|\\.)*)"(?!\s*:)/g 提取值，该正则在键的
 *   **闭合引号**处会重新起步——`"键":"值"` 里，键的闭合引号 + 冒号 + 值的开引号恰好构成
 *   一次匹配，捕获出的内容是「冒号本身」。于是 JSON 稍有残缺（多余逗号、少个括号）时，
 *   兜底结果退化成一串 `:` `,` 组成的残渣——即作者反馈的「改稿只剩标点」的成因之一。
 *   改为显式匹配 `"键"\s*:\s*"值"` 成对结构，只取值。
 */
export function humanText(raw: string): string {
  const s = stripCodeFence(raw)
  if (/[{[]/.test(s)) {
    const vals: string[] = []
    const pairRe = /"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = pairRe.exec(s))) {
      const v = unescapeJSONString(m[1]).trim()
      if (v) vals.push(v)
    }
    if (vals.length > 0) return vals.join('\n')
  }
  return s
    .replace(/"([^"]+)":\s*/g, '')
    .replace(/[{}[\]",]/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
}

/** 还原 JSON 字符串字面量里的转义（\\n → 换行、\\" → 引号、\\\\ → 反斜杠） */
function unescapeJSONString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}
