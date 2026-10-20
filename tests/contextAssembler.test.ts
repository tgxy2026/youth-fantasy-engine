/**
 * 上下文装配的**单段预算**（3.1.3 · R3）。
 *
 * 盯的是三件最容易漂的事（都是实测踩过才写下来的）：
 *   ① 巨段要**裁**，不能整段吃掉预算；
 *   ② 裁了就必须**真的进上下文**（不能"trimmed 记了、实际又丢了"这种自相矛盾）；
 *   ③ 放不下就是「没带」，别记进 trimmed —— 两者对模型是两件事。
 */
import { SEG_MIN, SEG_RATIO, fitBlock, segCapOf, trimEnabledFor } from '@/lib/ai/segBudget'
import { createContextAssembler } from '@/lib/ai/contextAssembler'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const line = (n: number, tag = '行') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}：内容内容内容内容内容内容内容内容`)

{
  // ---------- ① 纯函数：额度与开关 ----------
  ok('① 预算 12000 → 单段上限 3600', segCapOf(12000) === 3600, String(segCapOf(12000)))
  ok('① 预算 48000 → 单段上限 14400', segCapOf(48000) === 14400, String(segCapOf(48000)))
  ok('① 小预算走 SEG_MIN（不因预算小就切成 300）', segCapOf(3000) === SEG_MIN)
  ok('① 预算与比例的常量就是文档里写的 0.3 / 2000', SEG_RATIO === 0.3 && SEG_MIN === 2000)
  ok('① 大预算启用裁剪', trimEnabledFor(12000))
  ok('① 负向：小预算（伴写 1300）不裁，保持原行为', !trimEnabledFor(1300))
  ok('① 负向：非法预算不裁', !trimEnabledFor(Number.NaN))
}

{
  // ---------- ② fitBlock：按整行裁，且不能丢关键行 ----------
  const short = '行1：短'
  ok('② 不超限时原样返回（trimmed=false）', (() => {
    const r = fitBlock(short, 100)
    return r.text === short && !r.trimmed
  })())

  const body = line(40).join('\n')      // 40 行，远超 300
  const r = fitBlock(body, 300)
  ok('② 超限时 trimmed=true 并给出行数', r.trimmed && r.keptLines > 0 && r.totalLines === 40, `${r.keptLines}/${r.totalLines}`)
  ok('② 裁完不超过限额（含追加的说明句）', r.text.length <= 300 + 40, String(r.text.length))
  ok('② 第一行必留（表格首行是表头，丢了数据行读不懂）', r.text.startsWith('行1：'))
  ok('② 末尾注明「只带了前 N 行 / 共 M 行」', /本段按预算只带了前 \d+ 行 \/ 共 40 行/.test(r.text))

  // 末尾「另有 N 行未列出」是 renderTable 自己生成的口径，裁的时候不能把它裁掉
  const withTail = [...line(30), '（另有 99 行未列出）'].join('\n')
  const r2 = fitBlock(withTail, 260)
  ok('② 保留了原文末尾的「另有 N 行未列出」', r2.text.includes('（另有 99 行未列出）'))
  ok('② 负向：不会把「另有…」那段当成正文裁掉', r2.keptLines < 30)
}

{
  // ---------- ③ 装配器：裁 / 丢 / 整块 / 预留 ----------
  const a = createContextAssembler(12000)
  a.push('小段', '一句话')
  const big = line(200).join('\n')      // 约 1 万字符 > segCap 3600
  a.push('巨段', big)
  const built = a.build()
  ok('③ 小段整段进', built.sections.includes('小段'))
  ok('③ 巨段被裁后**确实进了**（不是记了 trimmed 又丢掉）',
    built.sections.includes('巨段') && built.trimmed.length === 1, JSON.stringify(built.trimmed))
  ok('③ 负向：被裁的段不能同时出现在 dropped 里',
    !built.dropped.includes('巨段'))
  ok('③ 文末同时声明「只带了一部分」', /只带了一部分/.test(built.text))

  // 预算放不下 ⇒ 就是 dropped，不记 trimmed（这条是修过的真 bug）
  const b = createContextAssembler(12000)
  // 用 whole 占位：不带 whole 的话它自己会被裁到单段上限，占不满
  b.push('占位', 'x'.repeat(11950), { whole: true })
  b.push('挤不进来', line(200).join('\n'))
  const built2 = b.build()
  ok('③ 放不下时进 dropped', built2.dropped.includes('挤不进来'))
  ok('③ 负向：放不下的段不许记进 trimmed（否则「带了一部分」是假话）', built2.trimmed.length === 0)

  // whole：附件永不裁
  const c = createContextAssembler(12000)
  c.push('附件', line(200).join('\n'), { whole: true })
  const built3 = c.build()
  ok('③ whole 段不裁（作者手动给的东西不切）',
    built3.sections.includes('附件') && built3.trimmed.length === 0)
  ok('③ 负向：whole 段放不下时整段丢，不给半截',
    !built3.sections.includes('附件') || built3.text.includes('行200'))

  // reserved：能动用预留额度
  const d = createContextAssembler(12000, { reserve: 3000 })
  d.push('常规', 'x'.repeat(8800))       // 常规额度 9000，占满
  d.push('常规2', 'y'.repeat(500))        // 剩余 200，装不下
  d.push('保留段', 'z'.repeat(2000), { reserved: true })
  const built4 = d.build()
  ok('③ 常规段用不满预留额度', built4.sections.includes('常规'))
  ok('③ 负向：常规段不许吃预留额度', !built4.sections.includes('常规2'))
  ok('③ 保留段能动用预留额度', built4.sections.includes('保留段'))

  /**
   * 3.1.3 · R3：保留段「额度不够长」时必须**裁进预留额度**而不是丢掉整段。
   * 实测踩过：清单 2558 字 / 预留 1800，旧逻辑按单段上限（4800）裁 ⇒ 裁完仍超 room ⇒ 整段丢，
   * 于是「抬了预算、也预留了」的章节清单依然一次都没进过上下文。
   */
  const f = createContextAssembler(16000, { reserve: 1800 })
  // 常规段用 whole 占满 14000（否则它自己会被裁到 4800，清单就整段放得下、测不到裁剪）
  f.push('常规占位', 'x'.repeat(13880), { whole: true })
  const manyLines = Array.from({ length: 200 }, (_, i) => `  第${i + 1}章 标题${i}`).join('\n')
  f.push('章节清单', manyLines, { reserved: true })
  const built5 = f.build()
  ok('③ 长清单裁进预留额度（不整段丢）', built5.sections.includes('章节清单'))
  ok('③ 负向：裁过的段要记进 trimmed', built5.trimmed.some(t => t.startsWith('章节清单')))
  ok('③ 负向：裁过的段不许同时出现在 dropped', !built5.dropped.includes('章节清单'))
  /**
   * 保尾时仍会保留首行（对清单来说那是第一卷标题；没有卷标题时就是第 1 章，只占一行）。
   * 所以断言要看的是「中间被省略、末尾最新章在」，而不是「首章不在」—— 差点写成后者。
   */
  ok('③ 保尾裁剪留住最新章、省略中间段',
    built5.text.includes('第200章 标题199') && !built5.text.includes('第20章 标题19'))
  ok('③ 保尾裁剪如实申报省略了多少行', /省略了中间 \d+ 行，保留最近 \d+ 行/.test(built5.text))

  // inlineDropNote=false：酒馆自己生成段，不要文末声明
  const e = createContextAssembler(12000, { inlineDropNote: false })
  e.push('占位', 'x'.repeat(11900))
  e.push('被丢的', 'yy')
  ok('③ 负向：inlineDropNote=false 时不写文末声明', !/未带入本提示/.test(e.build().text))
}

{
  // ---------- ④ 段级结果（3.2.0 · WQ4：发送清单的原料） ----------
  const a = createContextAssembler(12000)
  a.push('世界设定', 'w'.repeat(300))
  a.push('巨段', line(300).join('\n'))   // 会触发裁剪
  const built = a.build()
  const full = built.entries.find(e => e.title === '世界设定')
  const trimmed = built.entries.find(e => e.title === '巨段')
  ok('④ 整段装入记 scope=full 且长度真实', full?.scope === 'full' && full.includedChars === 300, JSON.stringify(full))
  ok('④ 裁剪记录 scope=trimmed 且带原因', trimmed?.scope === 'trimmed' && (trimmed.reason ?? '').includes('行'), JSON.stringify(trimmed))
  ok('④ 裁剪记录的长度是**实际保留**的那部分（小于原文）',
    (trimmed?.includedChars ?? 0) > 0 && (trimmed?.includedChars ?? 0) < line(300).join('\n').length,
    String(trimmed?.includedChars))

  // 放不下 ⇒ dropped 且带原因
  const b = createContextAssembler(1300, { inlineDropNote: false })
  b.push('大段', 'x'.repeat(1500))
  const bb = b.build()
  const dropped = bb.entries.find(e => e.title === '大段')
  ok('④ 未带入记 scope=dropped 且带原因', dropped?.scope === 'dropped' && Boolean(dropped.reason), JSON.stringify(dropped))
  ok('④ 未带入的长度为 0（不虚报已发）', dropped?.includedChars === 0)

  // 🔴 两遍装载：先丢弃、后被铺底装回来 ⇒ 结果只能有一条且是"已带入"
  const c = createContextAssembler(12000, { reserve: 6000, inlineDropNote: false })
  c.push('预留段', 'r'.repeat(5000), { reserved: true })
  c.push('常规段', 'n'.repeat(7000))       // 常规额度只剩 6000 ⇒ 先被丢
  c.push('常规段', 'n'.repeat(100), {})    // 再来一次（模拟第二遍铺底）⇒ 放得下
  const cc = c.build()
  const mixed = cc.entries.filter(e => e.title === '常规段')
  ok('🔴 同一段的丢弃记录会被清掉（不留"既发了又没发"）',
    mixed.length === 1 && mixed[0].scope !== 'dropped', JSON.stringify(mixed))
  ok('④ 段级结果与 sections 口径一致（装进去的都标 full/trimmed）',
    cc.entries.filter(e => e.scope !== 'dropped').every(e => cc.sections.includes(e.title)))
}

console.log(`\n—— contextAssembler 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
