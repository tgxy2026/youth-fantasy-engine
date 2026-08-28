// 一次性图片缩放工具：pngjs 读入 → 面积平均（box filter）降采样 → PNG 输出
// 用法：node scripts/resize-image.mjs <输入> <输出> <目标高度>
// 说明：JPG 输入不支持（pngjs 只读 PNG）；支付宝 jpg 请先转 PNG 或直接用原图。
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from '../node_modules/pngjs/lib/png.js'

const [inPath, outPath, targetHArg] = process.argv.slice(2)
if (!inPath || !outPath || !targetHArg) { console.error('用法: node scripts/resize-image.mjs <in> <out> <targetH>'); process.exit(1) }
const targetH = parseInt(targetHArg, 10)

const img = PNG.sync.read(readFileSync(inPath))
const { width: sw, height: sh } = img
const scale = Math.min(1, targetH / sh)
const dw = Math.round(sw * scale), dh = Math.round(sh * scale)
const out = new PNG({ width: dw, height: dh })

// 面积平均：输出每像素对应源图一个矩形区域，取均值（高质量降采样）
const xr = sw / dw, yr = sh / dh
for (let y = 0; y < dh; y++) {
  const sy0 = Math.floor(y * yr), sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((y + 1) * yr)))
  for (let x = 0; x < dw; x++) {
    const sx0 = Math.floor(x * xr), sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((x + 1) * xr)))
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * sw + sx) * 4
        const al = img.data[i + 3] / 255
        r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += img.data[i + 3]; n++
      }
    }
    const o = (y * dw + x) * 4
    // alpha 加权平均：先按预乘色求和，再统一除回 alpha 与采样数（除一次！）
    out.data[o] = a > 0 ? Math.round(r / (a / 255)) : 0
    out.data[o + 1] = a > 0 ? Math.round(g / (a / 255)) : 0
    out.data[o + 2] = a > 0 ? Math.round(b / (a / 255)) : 0
    out.data[o + 3] = Math.round(a / n)
  }
}

writeFileSync(outPath, PNG.sync.write(out))
console.log(`${inPath.split(/[\\/]/).pop()} ${sw}x${sh} -> ${outPath.split(/[\\/]/).pop()} ${dw}x${dh}`)
