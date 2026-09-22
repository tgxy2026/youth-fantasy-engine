/**
 * B8（2.4.1）地图底图 —— 单测
 *
 * 画布部分在 Node 里跑不了（与 imagePortrait 同样的现实），所以测**容易算错的那一步**：
 * `fitLongSide()` 的「只缩不放、保持比例」。
 */
import {
  fitLongSide, isAcceptableMapImage, MAP_IMAGE_MAX_SIDE, MAP_IMAGE_MAX_INPUT_BYTES,
  MAP_IMAGE_QUALITY_STEPS, MAP_IMAGE_HINT_SPEC,
} from '../src/lib/mapImage'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ mapImage')

// ---------- 1) fitLongSide：只缩不放、保持比例 ----------
{
  const M = MAP_IMAGE_MAX_SIDE

  const big = fitLongSide(4000, 3000, M)
  ok('长边收到上限', big.w === M, `${big.w}×${big.h}`)
  ok('🔴 保持宽高比（不拉伸）', Math.abs(big.w / big.h - 4000 / 3000) < 0.01, `${(big.w / big.h).toFixed(3)}`)

  const tallBig = fitLongSide(3000, 4000, M)
  ok('竖图按高收', tallBig.h === M, `${tallBig.w}×${tallBig.h}`)
  ok('🔴 竖图保持比例', Math.abs(tallBig.w / tallBig.h - 3000 / 4000) < 0.01, `${(tallBig.w / tallBig.h).toFixed(3)}`)

  const small = fitLongSide(800, 600, M)
  ok('🔴 小图不放大（避免糊）', small.w === 800 && small.h === 600, `${small.w}×${small.h}`)

  const exact = fitLongSide(M, 900, M)
  ok('正好等于上限时不动', exact.w === M && exact.h === 900, `${exact.w}×${exact.h}`)

  const junk = fitLongSide(0, -3, M)
  ok('非法尺寸不崩且至少 1px', junk.w >= 1 && junk.h >= 1, `${junk.w}×${junk.h}`)
}

// ---------- 2) 输入体检 ----------
{
  ok('接受 PNG', isAcceptableMapImage({ size: 1024, type: 'image/png' }).ok)
  ok('拒绝非图片', !isAcceptableMapImage({ size: 1024, type: 'application/pdf' }).ok)
  ok('拒绝空文件', !isAcceptableMapImage({ size: 0, type: 'image/png' }).ok)
  ok('拒绝超限并说明上限', (() => {
    const r = isAcceptableMapImage({ size: MAP_IMAGE_MAX_INPUT_BYTES + 1, type: 'image/jpeg' })
    return !r.ok && (r.reason ?? '').includes('16MB')
  })())
  ok('刚好等于上限视为通过', isAcceptableMapImage({ size: MAP_IMAGE_MAX_INPUT_BYTES, type: 'image/webp' }).ok)
}

// ---------- 3) 参数与文案 ----------
{
  ok('质量阶梯由高到低', MAP_IMAGE_QUALITY_STEPS[0] > MAP_IMAGE_QUALITY_STEPS[1] && MAP_IMAGE_QUALITY_STEPS[1] > MAP_IMAGE_QUALITY_STEPS[2],
    MAP_IMAGE_QUALITY_STEPS.join(' → '))
  ok('长边上限 1600', MAP_IMAGE_MAX_SIDE === 1600, String(MAP_IMAGE_MAX_SIDE))
  ok('规格文案含体积上限', MAP_IMAGE_HINT_SPEC.includes('16MB'))
  ok('🔴 规格文案承诺"不裁切、不拉伸"', MAP_IMAGE_HINT_SPEC.includes('不裁切') && MAP_IMAGE_HINT_SPEC.includes('不拉伸'))
  ok('规格文案说明可缩放平移', MAP_IMAGE_HINT_SPEC.includes('滚轮') && MAP_IMAGE_HINT_SPEC.includes('平移'))
}

console.log(`\n  mapImage: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
