// 一次性图片裁剪工具：PNG（pngjs）/ JPG（jpeg-js）→ 裁剪 → 可选缩放 → PNG 输出
// 用法：node scripts/crop-image.mjs <in> <out> <x> <y> <w> <h> [resizeH]
//   x/y/w/h 支持两种写法：绝对像素（如 120）或百分比（如 19.6%）
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const projReq = createRequire('G:/AI软件/novel-studio开发源码/package.json')
const wsReq = createRequire('C:/Users/18223/.workbuddy/binaries/node/workspace/package.json')
const { PNG } = projReq('pngjs')

const [inPath, outPath, xArg, yArg, wArg, hArg, resizeHArg] = process.argv.slice(2)
if (!inPath || !outPath || !xArg) { console.error('用法: node scripts/crop-image.mjs <in> <out> <x> <y> <w> <h> [resizeH]'); process.exit(1) }

const ext = path.extname(inPath).toLowerCase()
let raw
if (ext === '.png') {
  raw = PNG.sync.read(readFileSync(inPath))
} else if (ext === '.jpg' || ext === '.jpeg') {
  const jpeg = wsReq('jpeg-js')
  raw = jpeg.decode(readFileSync(inPath), { useTArray: true, maxMemoryUsageInMB: 1024 })
} else {
  console.error(`不支持的输入格式: ${ext}（仅 png/jpg）`); process.exit(1)
}
const { width: sw, height: sh, data } = raw
console.log(`源尺寸: ${sw}x${sh}`)

const parseCoord = (s, total) => s.endsWith('%') ? Math.round((parseFloat(s) / 100) * total) : parseInt(s, 10)
const cx = parseCoord(xArg, sw), cy = parseCoord(yArg, sh)
const cw = Math.min(parseCoord(wArg, sw), sw - cx), ch = Math.min(parseCoord(hArg, sh), sh - cy)
if (cw <= 0 || ch <= 0) { console.error(`裁剪区域无效: x=${cx} y=${cy} w=${cw} h=${ch}`); process.exit(1) }

const targetH = resizeHArg ? parseInt(resizeHArg, 10) : ch
const scale = targetH / ch
const dw = Math.round(cw * scale), dh = targetH
const out = new PNG({ width: dw, height: dh })

// 面积平均降采样（crop 内部坐标）
const xr = cw / dw, yr = ch / dh
for (let y = 0; y < dh; y++) {
  const sy0 = Math.min(ch - 1, Math.floor(y * yr)), sy1 = Math.min(ch, Math.max(sy0 + 1, Math.floor((y + 1) * yr)))
  for (let x = 0; x < dw; x++) {
    const sx0 = Math.min(cw - 1, Math.floor(x * xr)), sx1 = Math.min(cw, Math.max(sx0 + 1, Math.floor((x + 1) * xr)))
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const i = ((cy + sy) * sw + (cx + sx)) * 4
        const al = data[i + 3] / 255
        r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += data[i + 3]; n++
      }
    }
    const o = (y * dw + x) * 4
    out.data[o] = a > 0 ? Math.round(r / (a / 255)) : 255
    out.data[o + 1] = a > 0 ? Math.round(g / (a / 255)) : 255
    out.data[o + 2] = a > 0 ? Math.round(b / (a / 255)) : 255
    out.data[o + 3] = Math.round(a / n)
  }
}

writeFileSync(outPath, PNG.sync.write(out))
console.log(`输出: ${outPath.split(/[\\/]/).pop()} 裁剪(${cx},${cy},${cw},${ch}) -> ${dw}x${dh}`)
