// 3.2.0 · WQ8 证据守卫 · 单测
//
// 盯三件事：
//   ① 逐字命中 / 标点差异 / 截短引文都能认（模型引文长什么样都有）；
//   ② 编造的引文必须落到 `missing`（这部分是"作者最容易信的谎"）；
//   ③ 只报告不丢弃 —— 报告为空时不许刷屏，正文为空时不许假装核过。
import { checkEntityEvidence, describeEvidence } from '@/lib/ai/evidenceCheck'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const BODY = [
  '王铁柱提着铁锤走来，笑道：“今天炉子烧得旺。”',
  '青岚山积雪未消，山道上只有一行脚印。',
  '他默念噬命诀，指尖泛起黑气。',
].join('\n')

async function main() {
  // ---------- ① 三种"合法"引文 ----------
  {
    const r = checkEntityEvidence([
      { name: '王铁柱', evidence: '王铁柱提着铁锤走来' },
      { name: '青岚山', evidence: '青岚山积雪未消，山道上只有一行脚印。' },
      { name: '噬命诀', evidence: '他默念噬命诀，指尖泛起黑气' },
    ], BODY)
    ok('① 逐字命中记 quoted', r.quoted === 3 && r.missing === 0, JSON.stringify(r).slice(0, 120))
    ok('① 确实核验过（checked=true）', r.checked === true)
    ok('① 报告为空时不刷屏', describeEvidence(r) === '', describeEvidence(r))
  }

  // ---------- ② 标点 / 空白差异 ----------
  {
    const r = checkEntityEvidence([
      { name: '王铁柱', evidence: '王铁柱提着铁锤走来 笑道 今天炉子烧得旺' },
    ], BODY)
    ok('② 标点与空白被忽略后命中 ⇒ paraphrased', r.paraphrased === 1 && r.missing === 0,
      JSON.stringify(r.items))
  }

  // ---------- ③ 截短引文（模型常带省略号或只给前半句） ----------
  {
    const r = checkEntityEvidence([
      { name: '青岚山', evidence: '青岚山积雪…' },
    ], BODY)
    ok('③ 截短引文（前 12 字命中）⇒ paraphrased', r.paraphrased === 1 && r.missing === 0,
      JSON.stringify(r.items))
  }

  // ---------- ④ 编造的引文 ----------
  {
    const r = checkEntityEvidence([
      { name: '玄天老祖', evidence: '玄天老祖一掌拍碎了半座山' },
      { name: '王铁柱', evidence: '王铁柱提着铁锤走来' },
    ], BODY)
    ok('🔴 ④ 正文里没有的引文 ⇒ missing', r.missing === 1 && r.quoted === 1, JSON.stringify(r.items))
    const note = describeEvidence(r)
    ok('🔴 ④ 摘要点名到具体实体（作者能直接抽查）', note.includes('玄天老祖'), note)
    ok('④ 摘要说清"可能是转述或编造"', note.includes('转述') && note.includes('编造'), note)
  }

  // ---------- ⑤ 没有证据 / 没有正文 ----------
  {
    const noEvidence = checkEntityEvidence([
      { name: '甲', evidence: '' },
      { name: '乙' },
    ], BODY)
    ok('⑤ 没给证据 ⇒ empty（不算 missing，创意写作本来就没有原文）',
      noEvidence.empty === 2 && noEvidence.missing === 0 && describeEvidence(noEvidence) === '',
      JSON.stringify(noEvidence))

    const noBody = checkEntityEvidence([{ name: '甲', evidence: '随便一句话' }], '   ')
    ok('🔴 ⑤ 正文为空 ⇒ 不假装核验过（checked=false）', noBody.checked === false, JSON.stringify(noBody))
    ok('⑤ 正文为空时也不提示（无从核验就不该告警）', describeEvidence(noBody) === '')
  }

  // ---------- ⑥ 长引文截断展示 ----------
  {
    const long = '甲'.repeat(60)
    const r = checkEntityEvidence([{ name: '长', evidence: `${long}不在正文` }], BODY)
    ok('⑥ 摘要里的引文截到 40 字（不把整段贴进日志）', (r.items[0].quote.length <= 41), String(r.items[0].quote.length))
  }

  // ---------- ⑦ 接线闸 ----------
  {
    const src = readFileSync('src/lib/outline/autoContinue.ts', 'utf8')
    ok('⑦ 抽取完成后核验证据', /checkEntityEvidence\(entities, body\)/.test(src))
    ok('🔴 ⑦ 核验结果进了返回值的 errors（作者在运行日志里看得到）',
      /evidenceNote \? \{ errors: \[evidenceNote\] \}/.test(src))
    ok('🔴 ⑦ 只报告不丢弃（实体仍原样交给 commitEntities）',
      /commitEntities\(news, title, \{ pid \}\)/.test(src) && !/entities\.filter\([^)]*evidence/.test(src))
  }

  console.log(`\n———— evidenceGuard：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
