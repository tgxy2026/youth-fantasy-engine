/**
 * B2（2.4.1）投稿前自检 · 行文指纹与节奏 —— 单测
 *
 * 除了验统计正确性，还有一组**立场断言**（B2 的红线）：
 *   产物文本里**不得出现**「命中率 / 规避 / 反检测」，也**不得**出现「合格 / 不合格」这类评判词 ——
 *   这个功能是"把分布摆给你看"，不是"替你判定像不像机器写的"。
 */
import {
  splitSentences, splitParagraphs, variance, cv, repeatedGrams,
  analyzeStyle, toObservations, analyzePacing, buildCheckReportText, analyzeStyle as style,
} from '../src/lib/audit/manuscriptCheck'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ manuscriptCheck')

// ---------- 1) 切分 ----------
{
  const s = splitSentences('他抬起头。风很冷！你是谁？……好吧')
  ok('按句末标点切句', s.length >= 4, `${s.length} 句`)
  ok('句子不含空串', s.every(x => x.length > 0))

  const p = splitParagraphs('第一段\n\n第二段\n第三段')
  ok('按换行切段（空段剔除）', p.length === 3, `${p.length} 段`)
  ok('空文本切出 0 段', splitParagraphs('').length === 0)
  ok('空文本切出 0 句', splitSentences('   ').length === 0)
}

// ---------- 2) 离散度 ----------
{
  ok('方差：等值序列为 0', variance([5, 5, 5]) === 0)
  ok('方差：手算可核', variance([1, 3]) === 1, String(variance([1, 3])))
  ok('空序列不崩', variance([]) === 0)
  ok('cv：等值序列为 0', cv([10, 10, 10]) === 0)
  ok('cv：差异越大值越大', cv([1, 10]) > cv([4, 6]))
  ok('均值为 0 时不除零', cv([0, 0]) === 0)
}

// ---------- 3) 重复词组 ----------
{
  const t = '他抬起头看了看天空抬头看了看天气抬头看了看远方'
  const g = repeatedGrams(t, 3, 3)
  ok('检出反复出现的三字词组', g.length > 0, JSON.stringify(g.slice(0, 2)))
  ok('按出现次数降序', g.every((x, i) => i === 0 || x.count <= g[i - 1].count))
  ok('文本过短时返回空', repeatedGrams('短', 3, 3).length === 0)
}

// ---------- 4) 行文指纹 ----------
{
  // 刻意写"整齐"的一段：句长接近
  const even = '风在吹。雨在下。人在走。山在立。水在流。' + '云在飘。'
  const fp1 = analyzeStyle(even)
  ok('统计出句数', fp1.sentences >= 6, `${fp1.sentences}`)
  ok('整齐文本的句长离散度偏低', fp1.sentenceCv < 0.35, `${fp1.sentenceCv}`)

  // 刻意写"参差"的一段
  const uneven = '风在吹。他沿着那条被雨水泡得泥泞不堪的乡间小路一直往前走，走了很久很久，久到自己也记不清走了多少步。雨停。'
  const fp2 = analyzeStyle(uneven)
  ok('参差文本的句长离散度更高', fp2.sentenceCv > fp1.sentenceCv, `${fp1.sentenceCv} vs ${fp2.sentenceCv}`)

  // 套路词密度
  const cliche = '他不由得一愣，不禁深吸一口气，竟然忍不住笑了。'
  const fp3 = analyzeStyle(cliche)
  ok('检出套路词', fp3.clicheHits.length >= 3, JSON.stringify(fp3.clicheHits.map(x => x.word)))
  ok('套路词密度按千字计', fp3.clichePerK > 0, `${fp3.clichePerK}/千字`)

  const clean = analyzeStyle('他推开门，屋里没人，桌上留着一封信。')
  ok('没有套路词时密度为 0', clean.clichePerK === 0)
  ok('空文本不崩', analyzeStyle('').words === 0)
  ok('句长数组被截断到 200 条（防大章拖慢渲染）', analyzeStyle('一。'.repeat(500)).sentenceLens.length <= 200)
}

// ---------- 5) 观察文案：🔴 立场断言 ----------
{
  const fps = [
    analyzeStyle('风在吹。雨在下。人在走。山在立。'),
    analyzeStyle('他不由得一愣，不禁深吸一口气，竟然忍不住笑了。'),
    analyzeStyle('他推开门，屋里没人，桌上留着一封信。'),
  ]
  const all = fps.flatMap(fp => toObservations(fp))
  ok('产出观察条目', all.length > 0, `${all.length} 条`)
  const joined = all.map(o => `${o.label}${o.value}${o.hint}${o.note}`).join('\n')
  ok('🔴 不含反检测类措辞', !/命中率|规避|反检测|洗稿|机器写/.test(joined))
  ok('🔴 不含"合格 / 不合格"评判', !/不合格|合格|及格|评分/.test(joined))
  ok('用了"参考区间"这类中性说法', joined.includes('常见'))
  ok('每条都有解释（不是光给数字）', all.every(o => o.note.length > 5))
}

// ---------- 6) 节奏 ----------
{
  const chs = [
    { title: '第一章', content: '一'.repeat(3000), wordCount: 3000 },
    { title: '第二章', content: '二'.repeat(3050), wordCount: 3050 },
    { title: '第三章', content: '三'.repeat(2980), wordCount: 2980 },
    { title: '空章', content: '', wordCount: 0 },
  ]
  const r = analyzePacing(chs, [
    { date: '2026-09-20', words: 3000 },
    { date: '2026-09-21', words: 0 },
    { date: '2026-09-22', words: 3000 },
  ])
  ok('只统计有正文的章', r.written === 3, `${r.written}`)
  ok('识别出"各章字数非常接近"', r.observations.some(o => o.key === 'word-cv' && o.notable), JSON.stringify(r.observations.map(o => [o.key, o.notable])))
  ok('动笔天数只算有字的天', r.activeDays === 2, `${r.activeDays}`)
  ok('跨度含没写的天', r.spanDays === 3, `${r.spanDays}`)
  ok('日均按动笔天算', r.avgPerActiveDay === 3000, `${r.avgPerActiveDay}`)
  ok('找出最短 / 最长章', r.shortest.title === '第三章' && r.longest.title === '第二章', `${r.shortest.title}/${r.longest.title}`)
  ok('空列表不崩', analyzePacing([]).written === 0)

  const paceObs = r.observations.find(o => o.key === 'pace')
  ok('🔴 节奏只报事实、不判定"是否像人"', !!paceObs && !/人类|规律|异常/.test(paceObs.note), paceObs?.note)
}

// ---------- 7) 报告文本 ----------
{
  const fp = style('风在吹。雨在下。他沿着泥泞小路走了很久，久到记不清步数。')
  const pacing = analyzePacing([{ title: '第一章', content: fp.sentenceLens.map(() => '字').join(''), wordCount: 100 }], [])
  const txt = buildCheckReportText('测试书', fp, pacing, { continuity: 3, foreshadowOpen: 2, chapterTitle: '第一章' })
  ok('报告含书名', txt.includes('《测试书》'))
  ok('报告含矛盾数', txt.includes('3 处'))
  ok('报告含伏笔数', txt.includes('2 条'))
  ok('🔴 报告声明"未使用 AI"', txt.includes('未使用 AI'))
  ok('🔴 报告含"不是评分标准"的口径说明', txt.includes('不是评分标准'))
  ok('🔴 报告不含反检测类措辞', !/命中率|规避|反检测/.test(txt))
}

console.log(`\n  manuscriptCheck: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
