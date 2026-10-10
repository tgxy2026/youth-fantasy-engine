/**
 * B7（2.4.1）角色立绘 —— 单测
 *
 * 画布部分在 Node 里跑不了（与 imageAvatar 同样的现实），所以把**容易算错的那一步抽成了纯函数
 * `fitInside()`** 来测：等比缩放、不裁剪、不放大。
 * 这正是与头像管线最大的差别 —— 头像用 `fitSquare()` **裁**，立绘必须**不裁**。
 */
import { fitInside, dataUrlBytes, isAcceptablePortrait, PORTRAIT_QUALITY_STEPS } from '../src/lib/media/imagePortrait'
import { PORTRAIT_SIZE, PORTRAIT_HINT_SPEC, PORTRAIT_MAX_INPUT_BYTES } from '../src/lib/media/portraitSpec'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ imagePortrait')

// ---------- 1) 等比缩放：不裁、不变形 ----------
{
  const { w: W, h: H } = PORTRAIT_SIZE

  const exact = fitInside(W * 2, H * 2, W, H)
  ok('正好 9:16 的大图 → 收到 512×910', exact.w === W && exact.h === H, `${exact.w}×${exact.h}`)

  // 关键断言：宽高比必须保持（不拉伸）
  const ratio = (a: { w: number; h: number }) => a.w / a.h
  const wide = fitInside(2000, 500, W, H)     // 宽图
  ok('🔴 宽图保持原比例（不拉伸）', Math.abs(ratio(wide) - 2000 / 500) < 0.01, `${wide.w}×${wide.h}`)
  ok('🔴 宽图落在框内（不溢出）', wide.w <= W && wide.h <= H, `${wide.w}×${wide.h}`)
  ok('🔴 宽图**不被裁切**（宽度仍充满，说明没裁成方形）', wide.w === W, `${wide.w}`)

  const tall = fitInside(500, 2000, W, H)     // 超长竖图
  ok('🔴 超长竖图保持比例', Math.abs(ratio(tall) - 500 / 2000) < 0.01, `${tall.w}×${tall.h}`)
  ok('🔴 超长竖图落在框内', tall.w <= W && tall.h <= H, `${tall.w}×${tall.h}`)
  ok('🔴 超长竖图高度贴合（不裁掉两端）', tall.h === H, `${tall.h}`)

  // 与头像的差别：头像 `fitSquare` 会把图**裁成**正方形；立绘只做等比缩放。
  // 1000×1000 放进 512×910 → 宽度贴合得 512×512 —— **仍然是方的**，
  // 这正说明"没有被强行拉成 9:16 框"（否则会变成 512×910，那就拉伸变形了）。
  const square = fitInside(1000, 1000, W, H)
  ok('🔴 方图保持方形（不强行拉成 9:16 框 ⇒ 说明没拉伸）', square.w === square.h, `${square.w}×${square.h}`)
  ok('🔴 且不超出框高', square.h <= H, `${square.h}`)

  const small = fitInside(100, 178, W, H)
  ok('小图不放大（避免糊）', small.w === 100 && small.h === 178, `${small.w}×${small.h}`)

  const junk = fitInside(0, -5, W, H)
  ok('非法尺寸不崩且至少 1px', junk.w >= 1 && junk.h >= 1, `${junk.w}×${junk.h}`)
}

// ---------- 2) dataURL 体积估算 ----------
{
  // 'AAAA' → 3 字节；'AA==' → 1 字节
  ok('估算：4 个 base64 字符 = 3 字节', dataUrlBytes('data:image/webp;base64,AAAA') === 3, `${dataUrlBytes('data:image/webp;base64,AAAA')}`)
  ok('估算：带 == 补齐', dataUrlBytes('data:image/webp;base64,AA==') === 1, `${dataUrlBytes('data:image/webp;base64,AA==')}`)
  ok('估算：带 = 补齐', dataUrlBytes('data:image/webp;base64,AAA=') === 2, `${dataUrlBytes('data:image/webp;base64,AAA=')}`)
  ok('没有逗号时返回 0', dataUrlBytes('nope') === 0)
  ok('空串返回 0', dataUrlBytes('') === 0)
}

// ---------- 3) 输入体检 ----------
{
  ok('接受 PNG', isAcceptablePortrait({ size: 1024, type: 'image/png' }).ok)
  ok('接受 WebP', isAcceptablePortrait({ size: 1024, type: 'image/webp' }).ok)
  ok('拒绝非图片并说明原因', !isAcceptablePortrait({ size: 1024, type: 'text/plain' }).ok)
  ok('拒绝空文件', !isAcceptablePortrait({ size: 0, type: 'image/png' }).ok)
  ok('拒绝超限并给出上限', (() => {
    const r = isAcceptablePortrait({ size: PORTRAIT_MAX_INPUT_BYTES + 1, type: 'image/png' })
    return !r.ok && (r.reason ?? '').includes('8MB')
  })())
  ok('刚好等于上限视为通过', isAcceptablePortrait({ size: PORTRAIT_MAX_INPUT_BYTES, type: 'image/jpeg' }).ok)
}

// ---------- 4) 质量阶梯与规格文案 ----------
{
  ok('质量阶梯由高到低', PORTRAIT_QUALITY_STEPS[0] > PORTRAIT_QUALITY_STEPS[1] && PORTRAIT_QUALITY_STEPS[1] > PORTRAIT_QUALITY_STEPS[2],
    PORTRAIT_QUALITY_STEPS.join(' → '))
  ok('首档不低于头像的 0.85（立绘更保真）', PORTRAIT_QUALITY_STEPS[0] >= 0.9, String(PORTRAIT_QUALITY_STEPS[0]))
  ok('规格文案含比例', PORTRAIT_HINT_SPEC.includes('9:16'))
  ok('规格文案含尺寸', PORTRAIT_HINT_SPEC.includes('512×910'))
  ok('🔴 规格文案承诺"不裁切"', PORTRAIT_HINT_SPEC.includes('不裁切'))
  ok('规格文案含体积上限', PORTRAIT_HINT_SPEC.includes('8MB'))
}

console.log(`\n  imagePortrait: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
