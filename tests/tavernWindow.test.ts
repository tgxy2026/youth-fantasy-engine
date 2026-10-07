// ============ 酒馆「上下文窗口长度」只读化（2026-10-07 方案 B）· 防回归闸 ============
//
// 背景：面板原先是**可手填**的 `common.numCtx`，而模型配置里的 `provider.contextWindow`
// 才是全项目真源（2026-10-03 定案）⇒ 同一概念两份手填值，"谁说了算"说不清；且旧文案
// 承诺了「换模型时会自动带过来」，实测只在「模型配置真手填 + 指纹变了 + 自动调整开着」
// 三条同时满足时才跟随 ⇒ 文案与实现不一致。
//
// 方案 B 的落法：面板**改为只读派生**（显示 `cap.windowTokens` + 出处徽标），
// `common.numCtx` 字段**保留**作「模型配置未填时的沿用值」⇒ 老用户零回退、零迁移。
//
// 本闸守四件事：① 面板别再出现手填入口；② 展示值来自派生而非 c.numCtx；
//   ③ 旧承诺文案别回潮；④ 字段与安全阀（params.ts 的 num_ctx）都还在。
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
  const basics = read('src/components/TavernControlBasics.tsx')
  const hook = read('src/components/useTavernControlModel.ts')
  const settings = read('src/lib/tavern/settings.ts')
  const params = read('src/lib/tavern/params.ts')
  const capacity = read('src/lib/modelCapacity.ts')

  ok('找到 TavernControlBasics.tsx', !!basics)
  ok('找到 useTavernControlModel.ts', !!hook)
  if (!basics || !hook) { console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1) }

  // ---------- ① 面板不再有手填入口 ----------
  ok('① 面板无 `setCommon(\'numCtx\'` 手填写回（只读化前提）', !basics.includes("setCommon('numCtx'"))
  ok('① 面板不再用 NumField 承载窗口（已改 Field 只读壳）',
    !/label="上下文窗口长度"[\s\S]{0,80}?<NumField/.test(basics))

  // ---------- ② 展示值来自派生 ----------
  ok('② 面板展示 cap.windowTokens', basics.includes('cap.windowTokens'))
  ok('② 面板用 numCtxFromUserWindow 判出处（本地分支的 windowSource 是硬编码的 user，不能用）',
    basics.includes('cap.numCtxFromUserWindow'))
  ok('② 出处徽标两种态都在（来自模型配置 / 模型配置未填）',
    basics.includes('来自模型配置') && basics.includes('模型配置未填'))

  // ---------- ③ 旧承诺文案不得回潮 ----------
  ok('③ 旧文案「换模型时会自动带过来」已消失',
    !basics.includes('换模型时会自动带过来'))
  ok('③ 新文案写明「模型配置未填时沿用上次值」',
    basics.includes('沿用你上次在这里设的值'))

  // ---------- ④ 字段与安全阀仍在（零迁移、零回退的前提） ----------
  ok('④ settings.ts 仍保留 `numCtx` 字段（作「模型配置未填时的沿用值」）',
    /numCtx:\s*number/.test(settings))
  ok('④ 本地安全阀仍在：params.ts 的 `num_ctx: p.numCtx`',
    /num_ctx:\s*p\.numCtx/.test(params))
  ok('④ adviseCapacity 仍是「手填 > 面板现值」语义',
    /userWindow\s*\|\|\s*current\.numCtx/.test(capacity))
  ok('④ 仍按 `numCtxFromUserWindow` 决定是否写回面板值',
    /numCtxFromUserWindow/.test(capacity) && /numCtxFromUserWindow/.test(settings))

  // ---------- ⑤ 死代码已清 ----------
  // 用词边界匹配，避免被注释里的正式名称（带反引号）误伤
  ok('⑤ useTavernControlModel 不再导出无人消费的 gNumCtx', !/(^|[\s,{])gNumCtx\b/.test(hook))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
