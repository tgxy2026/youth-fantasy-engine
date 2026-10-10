// ============ 去 AI 味儿 · 单一真源（2.6.4）============
//
// 锁五件事：
//   ① **单一真源**：所有产出正文的入口都从 `lib/deAiStyle.ts` 取规则 —— 以前散在 inline / autoContinue 两处，
//      改一处另一处不动，社区反馈"去味儿效果不理想"的根子就在这儿（接线断言见第 5 组）；
//   ② **brief 档必须短**：伴写一次只续一两句话，塞完整版会把「只输出正文」这类硬要求挤没；
//   ③ **必须带免责说明**：只给禁令模型会机械清词，把文风洗坏（这条写在 DEAI_CAVEAT）；
//   ④ **🔴 立场红线**：注入给模型的文本里**不得出现"过检测 / 降 AI 率 / 绕过"** ——
//      这是文风质量功能，不是反检测功能，界面与提示词都不许那么写；
//   ⑤ **位置纪律**：去 AI 味的规则只有钉在 system **末尾**才有效（埋中段≈0，酒馆模式实测）。
import {
  DEAI_TELL_HARD, DEAI_TELL_SOFT, DEAI_TELL_PATTERNS, DEAI_PRINCIPLES, DEAI_CAVEAT,
  deAiGenerateRule, deAiPolishClause,
} from '../src/lib/ai/deAiStyle'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

// ---------- 1. 判据表本身 ----------
{
  const groups = Object.keys(DEAI_TELL_HARD)
  ok('一级词表分四组（神态 / 副词 / 内心 / 情态）', groups.length === 4, groups.join(','))
  const hardAll = Object.values(DEAI_TELL_HARD).flat()
  ok('一级词非空且数量足够（≥40）', hardAll.length >= 40, String(hardAll.length))
  ok('一级词无重复', new Set(hardAll).size === hardAll.length)
  ok('二级词非空', DEAI_TELL_SOFT.length >= 15, String(DEAI_TELL_SOFT.length))
  ok('句式模板非空（≥8 条）', DEAI_TELL_PATTERNS.length >= 8, String(DEAI_TELL_PATTERNS.length))
  // 只有"不要做什么"没有"该往哪儿写"，模型会产出干巴巴的干净句子
  ok('正面原则非空（≥6 条）', DEAI_PRINCIPLES.length >= 6, String(DEAI_PRINCIPLES.length))
  ok('免责说明存在（防机械清词）', DEAI_CAVEAT.includes('不是删除令'))
  // 需求里点名的两类（原先只有这两个固定预设）必须都在表里
  ok('神态模板类覆盖「嘴角勾起一抹」「眼中闪过」',
    DEAI_TELL_HARD['神态模板'].some(w => w.includes('嘴角勾起')) && DEAI_TELL_HARD['神态模板'].some(w => w.includes('眼中闪过')))
  ok('万能副词类覆盖「缓缓 / 微微 / 淡淡」',
    ['缓缓', '微微', '淡淡'].every(w => DEAI_TELL_HARD['万能副词'].includes(w)))
  ok('内心套话类覆盖「心中暗道」', DEAI_TELL_HARD['内心套话'].includes('心中暗道'))
}

// ---------- 2. brief / full 两档 ----------
{
  const brief = deAiGenerateRule('brief')
  const full = deAiGenerateRule('full')
  ok('brief 档更短（伴写不能塞完整版）', brief.length < full.length, `${brief.length} vs ${full.length}`)
  ok('brief 档控制在 300 字内', brief.length <= 300, String(brief.length))
  ok('brief 档仍点名了最要命的模板词', brief.includes('心中暗道') && brief.includes('嘴角勾起一抹'))
  ok('brief 档仍带「不复述前文」', brief.includes('复述'))
  ok('full 档含一级词表', full.includes('心中暗道') && full.includes('缓缓'))
  ok('full 档含二级词表', full.includes('不由自主') || full.includes('霎时'))
  ok('full 档含句式模板', full.includes('排比') || full.includes('三段式'))
  ok('full 档含正面原则', full.includes('身体感受') || full.includes('五感'))
  // 🔴 只有禁令会洗坏文风：full 档必须带免责说明
  ok('full 档带免责说明（不是删除令）', full.includes('不是删除令'))
  ok('改写档带免责说明', deAiPolishClause().includes('不是删除令'))
  ok('改写档额外要求改完自检', deAiPolishClause().includes('自检'))
}

// ---------- 3. 🔴 立场红线：注入给模型的文本里不许出现反检测话术 ----------
{
  const all = [deAiGenerateRule('brief'), deAiGenerateRule('full'), deAiPolishClause()].join('\n')
  for (const bad of ['过检测', '降 AI 率', '降低AI率', '绕过检测', '逃过检测', '洗掉 AI 痕迹', '规避检测']) {
    ok(`注入文本不含「${bad}」`, !all.includes(bad))
  }
  // 也不能用"检测率"这类暗示
  ok('注入文本不含「检测率」', !all.includes('检测率'))
}

// ---------- 4. 模板 id 稳定（创意写作 / 一键续写按 id 取值，改了会静默拿到空提示词） ----------
{
  const src = read('src/lib/outline/autoContinue.ts')
  for (const id of ['natural', 'webnovel', 'literary', 'custom']) {
    ok(`保留模板 id「${id}」`, src.includes(`id: '${id}'`))
  }
  // creativeSession 按 id 查表：查不到会返回空串 → 去味儿静默失效
  ok('creativeSession 按 id 查 DEAI_TEMPLATES', read('src/lib/creative/creativeSession.ts').includes('DEAI_TEMPLATES.find'))
  const tpls = src.slice(src.indexOf('DEAI_TEMPLATES: DeAiTemplate[]'), src.indexOf('export interface ChapterDraft'))
  ok('三套内置模板的提示词都非空', (tpls.match(/prompt: '/g) ?? []).length >= 3)
}

// ---------- 5. 接线断言：所有产出正文的入口都挂了、且都钉在末尾 ----------
{
  const inline = read('src/lib/aiTasks/inline.ts')
  ok('伴写取 deAiGenerateRule(brief)', /DEAI_INLINE_RULE = deAiGenerateRule\('brief'\)/.test(inline))
  const ilAt = inline.indexOf('layers.push(DEAI_INLINE_RULE)')
  const ilLayersEnd = inline.indexOf('layers.join', ilAt)
  ok('伴写把去味规则 push 在最后一层', ilAt > 0 && ilLayersEnd > ilAt, `${ilAt} / ${ilLayersEnd}`)

  const rw = read('src/lib/aiTasks/rewrite.ts')
  const rwLine = rw.split('\n').find(l => l.includes('CHAPTER_REWRITE_BASE, CHAPTER_REWRITE_ACTION_RULES')) ?? ''
  ok('整章改写挂了 deAiGenerateRule(full)', rwLine.includes("deAiGenerateRule('full')"), rwLine.trim().slice(0, 160))
  ok('整章改写把去味规则排在数组最后', rwLine.trim().endsWith(".join('\\n\\n')") && rwLine.indexOf("deAiGenerateRule('full')") > rwLine.indexOf('scopeRule'))

  const ac = read('src/lib/outline/autoContinue.ts')
  ok('续写初稿挂了 deAiGenerateRule(full)', ac.includes("    deAiGenerateRule('full'),"))
  // 初稿 system 由 buildSysPrompt 拼：去味规则必须是 join 之前的最后一项
  const bs = ac.slice(ac.indexOf('function buildSysPrompt'), ac.indexOf('// ============ 去 AI 味儿'))
  const lastItem = bs.slice(bs.lastIndexOf("deAiGenerateRule('full')"), bs.indexOf('].join', bs.lastIndexOf("deAiGenerateRule('full')")))
  ok('续写初稿的去味规则排在末位（中间没有别的条目）', lastItem.trim() === "deAiGenerateRule('full'),", JSON.stringify(lastItem.trim()))
  ok('润色 system 挂了 deAiPolishClause', ac.includes('deAiPolishClause()'))
}

console.log(`\ndeAiStyle: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
