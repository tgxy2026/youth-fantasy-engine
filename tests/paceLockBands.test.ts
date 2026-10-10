// 3.0 · W2-4 数值 ↔ 言行 ↔ 卡文一致性 · 单测
//
// 盯三件事（对应 §12 / §13 F1 / §13 F2）：
//   ① §12：`buildVarStateBlock` 把「当前档位 + 行为指引」注入扮演侧（数值项带、文本项不带、关掉为空）；
//   ② F1：`paceLockStartValues` 从卡文措辞推断起点档（🔴 复用 VAR_BANDS 的区间中点）；
//   ③ F2：`paceLockDrift` 跨档才产出（🔴 只提示、不自动改卡）。
import fs from 'node:fs'
import { buildVarStateBlock, emptyVars } from '../src/lib/tavern/vars'
import { VAR_BANDS, bandOf, type VarKey } from '../src/lib/tavern/types'
import { bandAnchorOf, paceLockStartValues, paceLockDrift, paceLockTargets } from '../src/lib/tavern/paceLockBands'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const NUM_KEYS: VarKey[] = ['affection', 'trust', 'progress']
const def = bandOf('trust', 0)!.name   // 「一般」

console.log('\n—— W2-4 用例开始 ——')

// ---------- ① §12 档位注入扮演侧 ----------
{
  const values = { affection: 45, trust: -10, progress: 0, mood: '若有所思', place: '书院' }
  const block = buildVarStateBlock({ values, keys: [...NUM_KEYS, 'mood', 'place'] })

  ok('① 含「当前档位」行', /当前档位：/.test(block))
  ok('① 数值项带档位名', /好感「亲近」/.test(block) && /信任「一般」/.test(block) && /精神「正常」/.test(block))
  ok('① 带行为指引（effect 原文）', block.includes(VAR_BANDS.affection[3].effect))
  ok('① 文本项（心情 / 地点）不出现档位', !/心情「/.test(block) && !/地点「/.test(block))
  ok('① 保留「不要把它抄进正文」尾句', block.includes('不要把它把它抄进正文') === false && block.includes('不要把它抄进正文'))
  ok('① 🔴 不塞整张五档表（只出当前一档）',
    !block.includes(VAR_BANDS.affection[0].effect) && !block.includes(VAR_BANDS.affection[4].effect))

  // 关掉（keys 为空）⇒ 整块为空
  ok('① keys 为空 ⇒ 返回空串', buildVarStateBlock({ values, keys: [] }) === '')
  // 只开文本项 ⇒ 无档位行
  const textOnly = buildVarStateBlock({ values, keys: ['mood', 'place'] })
  ok('① 只开文本项 ⇒ 无「当前档位」行', !/当前档位：/.test(textOnly) && textOnly.includes('〖本场数值〗'))
  // 值缺失 ⇒ 该档位不出（不炸）
  const missing = buildVarStateBlock({ values: { affection: 45 }, keys: NUM_KEYS })
  ok('① 值缺失项不出档位、不炸', /好感「亲近」/.test(missing) && !/信任「/.test(missing))
  // 越界值走端点档（bandOf 兜底夹取）
  const oob = buildVarStateBlock({ values: { trust: 999 }, keys: ['trust'] })
  ok('① 越界值走端点档（全然信赖）', /信任「全然信赖」/.test(oob))
}

// ---------- ② F1 起点推断 ----------
{
  ok('② 🔴 复用 VAR_BANDS：锚点 = 区间中点',
    bandAnchorOf('trust', '全然信赖') === Math.round((60 + 100) / 2))
  ok('② 文本项无档位 ⇒ null', bandAnchorOf('mood' as VarKey, '无所谓') === null)
  ok('② 档位名对不上 ⇒ null', bandAnchorOf('trust', '不存在的档') === null)

  const v1 = paceLockStartValues('已完全信任，愿意把身家性命托付')
  ok('② 「已完全信任」⇒ 落在 trust「全然信赖」档（§13 F1 的验收原句）',
    !!v1 && bandOf('trust', v1.trust!)?.name === '全然信赖')

  ok('② 空卡文 ⇒ null（不猜）', paceLockStartValues('') === null && paceLockStartValues('   ') === null)
  ok('② 🔴 无关措辞 ⇒ null（「按剧情节奏」没给阶段，猜出来比 0 更糟）',
    paceLockStartValues('按剧情自然节奏推进，不刻意加速') === null)

  const v2 = paceLockStartValues('关系已到亲密，可以恋人相处')
  ok('② 「亲密 / 恋人」⇒ affection「亲密依赖」档',
    !!v2 && bandOf('affection', v2.affection!)?.name === '亲密依赖')

  const v3 = paceLockStartValues('彼此还很疏远')
  ok('② 「疏远」⇒ affection 负档', !!v3 && (v3.affection ?? 0) < 0)

  // 🔴 具体优先：同时出现「完全信任」与「信任」时不该落到低一档
  const v4 = paceLockStartValues('从一般信任升到完全信任')
  ok('② 🔴 具体措辞优先（「完全信任」不被「信任」抢走）',
    !!v4 && bandOf('trust', v4.trust!)?.name === '全然信赖')

  const t = paceLockTargets('已完全信任')
  ok('② 同一项只出一条目标', t.length === 1 && t[0].key === 'trust')
}

// ---------- ③ F2 一致性提示 ----------
{
  const lock = '已完全信任'
  ok('③ 数值已在「全然信赖」⇒ 不产出（一致）',
    paceLockDrift(lock, { trust: 80 }).length === 0)
  const d1 = paceLockDrift(lock, { trust: -10 })
  ok('③ 数值还在「一般」⇒ 产出并说明两边档位',
    d1.length === 1 && d1[0].key === 'trust' && d1[0].wantBand === '全然信赖' && d1[0].nowBand === '一般')
  ok('③ 带上中文名（面板文案直接用）', d1[0].label === '信任')

  ok('③ 🔴 卡文空 ⇒ 不产出', paceLockDrift('', { trust: -10 }).length === 0)
  ok('③ 🔴 卡文没提到该项 ⇒ 不产出（作者没表达意图，谈不上不一致）',
    paceLockDrift('彼此还很疏远', { trust: -90 }).every(d => d.key !== 'trust'))
  ok('③ 值缺失 ⇒ nowBand null 且仍产出（提示「未知」）',
    paceLockDrift(lock, {})[0]?.nowBand === null)
}

// ---------- ④ 源码闸 ----------
{
  const readFileSync = fs.readFileSync
  const bands = readFileSync('src/lib/tavern/paceLockBands.ts', 'utf8')
  ok('④ 🔴 档位与刻度一律取自 VAR_BANDS（bandsOf/bandOf），不另造', bands.includes('bandsOf(') && bands.includes('bandOf('))
  ok('④ 🔴 不写卡（模块内无 writeCardField / 任何写操作）',
    !bands.includes('writeCardField') && !bands.includes('saveFreeChar'))
  const panel = readFileSync('src/components/TavernVarsPanel.tsx', 'utf8')
  ok('④ 🔴 面板只提示不自动改卡（无写入调用）',
    panel.includes('这里不会自动改卡') && !panel.includes('writeCardField'))
  const vars = readFileSync('src/lib/tavern/vars.ts', 'utf8')
  ok('④ 注入侧声明「只输出当前档位一行」的纪律', vars.includes('绝不把五档全表塞进来'))
  ok('④ emptyVars 仍导出（F1 起点用它打底）', typeof emptyVars === 'function' && emptyVars().values.affection === 0)
  void def
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
