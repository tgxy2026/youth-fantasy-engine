// ============ 酒馆「上下文窗口长度」两态化（2026-10-07 方案 C）· 防回归闸 ============
//
// 【沿革】
//  原形态：面板可手填 `common.numCtx`，而「模型配置 → 上下文窗口」才是全项目真源 ⇒ 同一概念
//          两份手填值，"谁说了算"说不清；旧文案还承诺了不存在的「换模型自动带过来」。
//  方案 B（2026-10-07 上午）：改**只读派生**（显示 `cap.windowTokens` + 出处徽标）。
//  方案 C（同日，主人拍板）：**按当前模型分两态** ——
//    · 云端：整项**灰显占位、不出数字、不可编辑**。`num_ctx` 对 OpenAI 兼容端点无效，
//            旧形态在这里显示一个大数字（看着像"可设置"）＋一句"设了也不生效"，
//            实测会让作者误以为「系统没适配他选的模型」。
//    · 本地：**恢复可编辑**，但编辑的是「模型配置 → 上下文窗口」**那一处真源**
//            （`setLocalWindow` 写 `provider.contextWindow`），**不再写 `common.numCtx`** ——
//            因为 `adviseCapacity` 本地分支是 `userWindow || current.numCtx`，模型配置填过时
//            面板值会被完全忽略，写它必然落进「能编辑、改了不生效」。
//            `common.numCtx` 字段仍**保留**作「模型配置未填时的沿用值」＋本地 `num_ctx` 显存安全阀。
//
// 【本闸守七件事】
//  ① 面板不再写酒馆自己的 numCtx；② 云端态不出数字、有占位文案；
//  ③ 本地态走 NumField 且挂 `gNumCtx` 取值范围；④ 写回走 saveProviders/contextWindow、
//  校验复用 `checkContextWindow`、值没变要短路；⑤ 字段与安全阀仍在（零迁移、零回退）；
//  ⑥ 方案 B 遗留的出处徽标与死变量已清；⑦ 显示值仍来自派生 `cap.windowTokens`。
//
// 纯静态、零 IO —— 归 A 批。
import * as fs from 'fs'
import * as path from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function read(rel: string): string {
  for (const base of [process.cwd(), path.join(process.cwd(), '..')]) {
    const p = path.join(base, rel)
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8')
  }
  return ''
}

function main() {
  const basics = read('src/components/tavern/TavernControlBasics.tsx')
  const hook = read('src/components/tavern/useTavernControlModel.ts')
  const settings = read('src/lib/tavern/settings.ts')
  const params = read('src/lib/tavern/params.ts')
  const capacity = read('src/lib/ai/modelCapacity.ts')

  ok('找到 TavernControlBasics.tsx', !!basics)
  ok('找到 useTavernControlModel.ts', !!hook)
  if (!basics || !hook) { console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1) }

  // ---------- ① 面板不再写酒馆自己的 numCtx ----------
  ok('① 面板无 `setCommon(\'numCtx\'` 手填写回（方案 C：改的是模型配置）',
    !basics.includes("setCommon('numCtx'"))

  // ---------- ② 云端态：灰显占位、不出数字 ----------
  ok('② 面板按 cap.local 分两态', basics.includes('cap.local ?'))
  // 2026-10-09 审计：分层的占位文案抽到了 components/SamplingUnavailable（三处共用一份 →
  //   防止「一处改了判据、别处没跟上」，也顺带把措辞从「对云端模型不适用」改成更准的
  //   「只对本地 Ollama 生效」—— 本地 OpenAI 兼容服务同样认不了那几个键）。
  ok('② 云端态有灰显占位（走共享组件 SamplingUnavailable）', basics.includes('<SamplingUnavailable'))
  ok('② 云端态不再把窗口当「设置值」显示（旧的 toLocaleString 大数字已移除）',
    !basics.includes('cap.windowTokens.toLocaleString()'))
  ok('② 旧文案「故这里只列出来供参考」已消失', !basics.includes('故这里只列出来供参考'))

  // ---------- ③ 本地态：恢复 NumField + 取值范围建议 ----------
  ok('③ 本地态用 NumField 承载窗口（可编辑）',
    /<NumField[\s\S]{0,140}?label="上下文窗口长度"/.test(basics))
  ok('③ 本地态挂 gNumCtx 取值范围/分段说明', basics.includes('guide={gNumCtx}'))
  ok('③ 本地态提交走 setLocalWindow', basics.includes('onCommit={setLocalWindow}'))
  ok('③ hook 恢复 gNumCtx（dynamicGuide numCtx）', /gNumCtx\s*=\s*dynamicGuide\('numCtx'/.test(hook))

  // ---------- ④ 写回模型配置（单一真源） ----------
  ok('④ hook 用 saveProviders 落盘', /saveProviders\(/.test(hook))
  ok('④ 写的是 provider.contextWindow', /contextWindow:\s*n/.test(hook))
  ok('④ 校验复用 checkContextWindow（禁自造阈值）', /checkContextWindow\(n\)\.ok/.test(hook))
  ok('④ 值没变就短路（NumField 范围内即时提交，不能每敲一个数字都落盘）',
    /if\s*\(n === p\.contextWindow\)\s*return/.test(hook))
  ok('④ 先写库再更新 state（异步落盘＋通知刷新）',
    /await saveProviders\(next\)[\s\S]{0,80}?setProviders\(next\)/.test(hook))

  // ---------- ⑤ 字段与安全阀仍在（零迁移、零回退） ----------
  ok('⑤ settings.ts 仍保留 numCtx 字段（模型配置未填时的沿用值）', /numCtx:\s*number/.test(settings))
  ok('⑤ 本地安全阀仍在：params.ts 的 `num_ctx: p.numCtx`', /num_ctx:\s*p\.numCtx/.test(params))
  ok('⑤ adviseCapacity 仍是「手填 > 面板现值」语义', /userWindow\s*\|\|\s*current\.numCtx/.test(capacity))

  // ---------- ⑥ 方案 B 遗留已清 ----------
  ok('⑥ 不再用 numCtxFromUserWindow 拼出处徽标', !basics.includes('numCtxFromUserWindow'))
  ok('⑥ 面板不再有 winFromConfig / winByPreset 死变量',
    !/\bwinFromConfig\b/.test(basics) && !/\bwinByPreset\b/.test(basics))
  ok('⑥ 旧徽标文案已消失', !basics.includes('模型配置未填 · 沿用上次设置'))

  // ---------- ⑦ 显示值仍来自派生 ----------
  ok('⑦ 本地面板的 value 仍是派生值 cap.windowTokens', /value=\{cap\.windowTokens\}/.test(basics))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
