// ============ AI 返回解析器（aiParse）单元测试 ============
// 这是纯函数，是全项目「模型文本 → 结构化数据」的唯一入口，必须锁死行为。
// 重点覆盖两件事：
//   ① 2.0.1 修过的「单对象被丢成空数组」——绝不能回归（否则"改稿只剩标点"复现）；
//   ② 剥代码块 / 切最外层 / 容忍前后夹带解释——旧实现三份行为不一致，现已统一。
import { parseObjectArray, parsePlainObject, parseLooseObject, parseTruncatedJson, stripCodeFence, stripStrayPunct, hasSubstance, asText, humanText } from '../src/lib/aiParse'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- stripCodeFence ----------
{
  ok('剥 ```json 围栏', stripCodeFence('```json\n{"a":1}\n```') === '{"a":1}')
  ok('剥裸 ``` 围栏', stripCodeFence('```\n[1]\n```') === '[1]')
  ok('无围栏时原样返回（仅 trim）', stripCodeFence('  {"a":1}  ') === '{"a":1}')
}

// ---------- parseObjectArray ----------
{
  ok('标准对象数组', parseObjectArray('[{"a":1},{"a":2}]').length === 2)
  ok('数组里的非对象被过滤', parseObjectArray('[{"a":1},3,"x",null]').length === 1)
  ok('空数组返回空数组', parseObjectArray('[]').length === 0)

  // 🔴 核心回归：单个对象必须归一化成单元素数组，不得丢失（2.0.1 修复点）
  const single = parseObjectArray('{"rewritten":"正文内容","level":"ok"}')
  ok('【回归】单个对象 → 归一化为 1 条（不得丢成空数组）', single.length === 1, `实际长度=${single.length}`)
  ok('【回归】单对象内容完整保留', single.length === 1 && single[0].rewritten === '正文内容')

  // {list:[…]} / {data:[…]} 形态
  ok('{list:[…]} 取内部数组', parseObjectArray('{"list":[{"a":1},{"a":2}]}').length === 2)
  ok('{data:[…]} 取内部数组', parseObjectArray('{"data":[{"a":1}]}').length === 1)
  ok('{list:[]} 空内部数组仍可解析出对象本身以外的空', parseObjectArray('{"list":[]}').length === 0)

  // 夹带解释 / 代码块
  ok('夹带前置解释仍能解析数组', parseObjectArray('好的，结果如下：\n[{"a":1}]').length === 1)
  ok('夹带后置解释仍能解析数组', parseObjectArray('[{"a":1}]\n以上是结果。').length === 1)
  ok('```json 围栏内数组可解析', parseObjectArray('```json\n[{"a":1},{"a":2}]\n```').length === 2)
  ok('围栏 + 夹带解释的单个对象可解析', parseObjectArray('```json\n{"a":1}\n```\n希望有帮助').length === 1)

  // 垃圾输入
  ok('纯文本返回空数组', parseObjectArray('抱歉我不能完成这个请求').length === 0)
  ok('空串返回空数组', parseObjectArray('').length === 0)
  ok('残缺 JSON 返回空数组', parseObjectArray('[{"a":').length === 0)
  ok('不抛异常（残缺 JSON）', (() => { try { parseObjectArray('{'); return true } catch { return false } })())
}

// ---------- parsePlainObject ----------
{
  ok('标准对象', parsePlainObject('{"1":"甲","2":"乙"}')?.['1'] === '甲')
  ok('围栏内对象', parsePlainObject('```json\n{"1":"甲"}\n```')?.['1'] === '甲')
  ok('夹带解释的对象', parsePlainObject('填空结果：{"1":"甲"} 完成')?.['1'] === '甲')
  ok('数组包裹时取首元素（容错）', parsePlainObject('[{"1":"甲"}]')?.['1'] === '甲')
  ok('纯文本返回 null', parsePlainObject('无法完成') === null)
  ok('空串返回 null', parsePlainObject('') === null)
}

// ---------- hasSubstance（拦「只剩标点」的残骸） ----------
{
  ok('纯标点/符号判定为无实质内容', hasSubstance('，。！？——【】（）…') === false)
  ok('仅数字与符号判定为无实质内容', hasSubstance('123 456 ，。') === false)
  ok('真实文字判定为有实质内容', hasSubstance('他推开那扇门') === true)
  ok('四字（边界值）判定为有实质内容', hasSubstance('推开了门') === true)
  ok('三字（低于阈值）判定为无实质内容', hasSubstance('推开门') === false)
}

// ---------- asText ----------
{
  ok('字符串原样（去首尾空白）', asText(' 甲 ') === '甲')
  ok('数字转字符串', asText(12) === '12')
  ok('布尔转字符串', asText(false) === 'false')
  ok('数组用顿号连接', asText(['甲', '乙']) === '甲、乙')
  ok('嵌套数组递归连接', asText([['甲'], '乙']) === '甲、乙')
  ok('对象返回空串（不可展示）', asText({ a: 1 }) === '')
  ok('null/undefined 返回空串', asText(null) === '' && asText(undefined) === '')
}

// ---------- humanText（JSON 解析失败时的兜底清洗） ----------
{
  // 含 JSON：只取「值」，不取键名
  const jsonish = '{"rewritten":"他推开了门。","level":"ok"}'
  const t1 = humanText(jsonish)
  ok('从 JSON 中只提取值、不含键名', t1.includes('他推开了门。') && !t1.includes('rewritten'), JSON.stringify(t1))

  ok('\\n 转义还原为真实换行', humanText('{"a":"第一行\\n第二行"}').includes('\n'))

  // 🔴 bug 锁：旧实现的正则会从键的闭合引号处重新起步、把 `":"` 捕获成冒号，
  //    导致残缺 JSON 的兜底结果退化成 `:\n,\n:` 这类标点残渣（作者报的「只剩标点」成因之一）。
  const malformed = humanText('{"rewritten":"他推开了门。",}')
  ok('【bug 锁】残缺 JSON 兜底取出正文，而非冒号逗号残渣',
    malformed.includes('他推开了门。') && !/^[\s:,\[\]{}"'\\]*$/.test(malformed), JSON.stringify(malformed))

  // 不含 JSON：剥掉键名残余与 JSON 符号
  const t2 = humanText('"rewritten": 正文内容 { ok }')
  ok('非 JSON 文本剥掉带引号的键名与括号', !t2.includes('{') && !t2.includes('}') && !t2.includes('rewritten') && t2.includes('正文内容'), JSON.stringify(t2))

  ok('普通文本保持可读', humanText('  他推开了门。\n  风灌了进来。  ') === '他推开了门。\n风灌了进来。')
  ok('剥代码块围栏', humanText('```\n{"a":"正文"}\n```').includes('正文'))
}

// ---------- 三份旧实现行为一致性（收敛的意义） ----------
{
  // 旧 autoContinue 用的是裸 JSON.parse：这两种输入它会整条丢弃，统一后应能解析
  const fenced = '```json\n[{"name":"青云门","note":"新增门派"}]\n```'
  ok('【收敛验证】带围栏输入不再整条丢弃（旧裸 JSON.parse 会丢）', parseObjectArray(fenced).length === 1)
  const withProse = '以下是变化：\n[{"name":"李默","note":"修为提升"}]\n完毕。'
  ok('【收敛验证】夹带散文输入不再整条丢弃', parseObjectArray(withProse).length === 1)
}

// ---------- parseLooseObject / stripStrayPunct（2026-09-18 新增：生成型入口的容错路径） ----------
// 第一条样本是**实机抓到的原文**：小模型在 JSON 结构位塞了个中文顿号，
// 严格解析整批丢弃 → 表现为"生成成功但 0 条"，作者完全无从下手（排查了一整轮才定位）。
{
  const REAL_BROKEN = `{
  "characters": [
    {
      "name": "林烬",
      "tier": "主要",
      "desc": "少年，靠吞噬他人修为续命",
      "realm": "碎境巅峰",
     、
      "faction": "夜渊会",
      "special": "可借他人修为短暂化形"
    }
  ]
}`
  ok('【判别力】严格解析在实机样本上确实失败', parsePlainObject(REAL_BROKEN) === null)
  const fixed = parseLooseObject(REAL_BROKEN)
  ok('🔴 宽松解析救回实机样本', !!fixed && Array.isArray(fixed.characters), JSON.stringify(Object.keys(fixed ?? {})))
  const c = (fixed?.characters as Record<string, unknown>[] | undefined)?.[0]
  ok('顿号之前的字段完好（realm）', c?.realm === '碎境巅峰', String(c?.realm))
  ok('顿号之后的字段也在（faction）', c?.faction === '夜渊会', String(c?.faction))

  // 🔴 负面对照：字符串**内部**的顿号/句号是正常内容，绝不能删
  const withPunctInside = '{"desc":"江、河、湖、海，皆可吞。","name":"林烬"}'
  ok('🔴 字符串内的顿号保持原样', stripStrayPunct(withPunctInside).includes('江、河、湖、海，皆可吞。'))
  ok('值读出来与原句一致（未被清洗）', parseLooseObject(withPunctInside)?.desc === '江、河、湖、海，皆可吞。', String(parseLooseObject(withPunctInside)?.desc))

  // 转义引号不应把"字符串外"判断搞错
  const escaped = '{"a":"他说：\\"江、河。\\"","b":"x、y"}'
  const cleanedEsc = stripStrayPunct(escaped)
  ok('转义引号内的顿号未被删', cleanedEsc.includes('江、河。'), cleanedEsc)
  ok('末尾字符串的顿号未被删', cleanedEsc.includes('x、y'), cleanedEsc)

  // 尾随逗号 / 连续逗号
  ok('严格解析在尾随逗号上失败', parsePlainObject('{"a":"1","b":"2",}') === null)
  ok('宽松解析处理尾随逗号', parseLooseObject('{"a":"1","b":"2",}')?.b === '2')
  ok('数组内尾随逗号也能处理', Array.isArray(parseLooseObject('{"list":["x","y",]}')?.list))
  ok('连续逗号收敛为一个', parseLooseObject('{"a":"1",,"b":"2"}')?.b === '2')

  // 合法输入不被"清洗"（严格路径原样返回）
  const good = '{"characters":[{"name":"张三"}],"factions":[{"name":"青岚宗"}]}'
  ok('合法输入两条路径结果一致', JSON.stringify(parsePlainObject(good)) === JSON.stringify(parseLooseObject(good)))
  ok('合法输入里含顿号的值原样保留', parseLooseObject('{"a":"甲、乙"}')?.a === '甲、乙')

  // 真·坏输入仍返回 null（不硬造对象）
  ok('空串 → null', parseLooseObject('') === null)
  ok('无 JSON 的纯文本 → null', parseLooseObject('今天天气不错') === null)
  ok('顶层是数组时取首元素（沿用 parsePlainObject 既有容错，非 null）',
    parseLooseObject('[{"a":1}]')?.a === 1, JSON.stringify(parseLooseObject('[{"a":1}]')))
}

// ============ 截断修复（parseTruncatedJson）：被测出来的真实场景 ============
// 2026-09-18 创意写作实机：本地 27B 产大纲时输出到一半停住，原始返回**少一个外层 `}`**：
//   {"volumes":[…],"chapters":[{…,"scenes":["…","…"]}]
// 旧实现要求结构完整 → 整批全丢 → 上游报"模型没有产出章节细纲"；重试同 prompt 又断在同一处。
{
  const full = '{"volumes":[{"title":"风起云州"}],"chapters":[{"title":"废脉","scenes":["a","b"]}]}'
  ok('① 完整 JSON 照常解析', (parseTruncatedJson(full) as { chapters: unknown[] })?.chapters?.length === 1)

  // 少一个外层 }（实机抓到的原始形态）
  const cutTail = full.slice(0, -1)
  const r1 = parseTruncatedJson(cutTail) as { volumes: unknown[]; chapters: { title: string; scenes: string[] }[] }
  ok('🔴 少一个收尾括号 → 补齐后仍能拿到全部内容（不再全丢）',
    r1?.chapters?.length === 1 && r1.chapters[0].title === '废脉', JSON.stringify(r1)?.slice(0, 120))
  ok('　· 场景数组内容一根不少', r1?.chapters?.[0]?.scenes?.join(',') === 'a,b')

  // 截断在字符串中间（流式被掐断的典型形态）
  const cutStr = '{"volumes":[{"title":"风起云州"}],"chapters":[{"title":"废'
  const r2 = parseTruncatedJson(cutStr) as { chapters: { title: string }[] }
  ok('② 截断在字符串中间 → 补引号后保住已完整的部分',
    r2?.chapters?.[0]?.title === '废', JSON.stringify(r2))

  // 截断在数组元素中间：丢掉不完整的那条，保住前面
  const cutMid = '{"chapters":[{"title":"A"},{"title":"B"},{"ti'
  const r3 = parseTruncatedJson(cutMid) as { chapters: { title: string }[] }
  ok('③ 截断在数组元素中间 → 丢掉残条、保住前两条',
    r3?.chapters?.length === 2 && r3.chapters.map(c => c.title).join('') === 'AB',
    JSON.stringify(r3))

  // 字符串内部的 } / ] 不能被当成结构闭合符（否则会切坏内容）
  const inner = '{"chapters":[{"note":"他说{别动}","title":"甲"}]'
  const r4 = parseTruncatedJson(inner) as { chapters: { note: string; title: string }[] }
  ok('④ 字符串内的 { } 不参与结构补全（内容不被切坏）',
    r4?.chapters?.[0]?.note === '他说{别动}' && r4.chapters[0].title === '甲',
    JSON.stringify(r4))

  // 绝不编造：救不回来就老实返回 null，让调用方走失败分支
  ok('🔴 ⑤ 纯垃圾 → null（不猜、不造）', parseTruncatedJson('今天天气不错') === null)
  ok('🔴 ⑤ 空串 → null', parseTruncatedJson('') === null)
  ok('🔴 ⑤ 只有开头括号 → null', parseTruncatedJson('{') === null)

  // 悬挂的逗号/冒号（"…"," 或 "…":）
  const dangling = '{"a":1,"b":'
  ok('⑥ 悬挂的冒号 → 去掉后能解析出已有的键', (parseTruncatedJson(dangling) as { a: number })?.a === 1)

  ok('⑦ 代码块围栏内的截断 JSON 也能修', (parseTruncatedJson('```json\n' + cutTail + '\n```') as { chapters: unknown[] })?.chapters?.length === 1)
}

// 两个入口的末级兜底真的接上了（否则上面修好了、调用方仍拿不到）
{
  // ⚠️ 样例刻意**含两个顶层键**：只用 `{"chapters":[{…}]` 这类会被 `parsePlainObject` 的
  //    "数组里取首元素"容错先接住（返回 `{title:…}`、丢掉外层 chapters），测不到本层兜底。
  const cut = '{"volumes":[{"title":"甲"}],"chapters":[{"title":"乙"}]'
  ok('🔴 parseLooseObject 走到截断兜底（外层键不丢）',
    (parseLooseObject(cut) as { chapters: unknown[] })?.chapters?.length === 1, JSON.stringify(parseLooseObject(cut)))
  const cutArr = '{"list":[{"n":"甲"},{"n":"乙"}]'
  ok('🔴 parseObjectArray 走到截断兜底（保住前 N-1 条）',
    parseObjectArray(cutArr).length === 2, JSON.stringify(parseObjectArray(cutArr)))
}

console.log(`\naiParse: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
