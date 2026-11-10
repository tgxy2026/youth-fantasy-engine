// 把已生成的截图缩小并统计亮度/色数，用于判断画面是否空白、是否偏暗。
// 只读既有 PNG，不重渲染界面。
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const dir = path.join(process.cwd(), '.workbuddy', 'tmp', 'community-ui')
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png') && !f.includes('-720'))
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
const page = await browser.newPage({ viewport: { width: 720, height: 450 } })
const report = []
for (const f of files) {
  const b64 = (await fs.readFile(path.join(dir, f))).toString('base64')
  await page.setContent(`<body style="margin:0"><img id="i" style="width:720px;height:450px;object-fit:contain;background:#000" src="data:image/png;base64,${b64}"></body>`)
  await page.waitForFunction(() => document.getElementById('i')?.complete)
  const stats = await page.evaluate(() => {
    const img = document.getElementById('i')
    const c = document.createElement('canvas')
    c.width = 720; c.height = 450
    const x = c.getContext('2d')
    x.drawImage(img, 0, 0, 720, 450)
    const d = x.getImageData(0, 0, 720, 450).data
    let sum = 0
    const set = new Set()
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      set.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`)
    }
    return { avgLum: Math.round(sum / (d.length / 4)), colors: set.size }
  })
  await page.screenshot({ path: path.join(dir, f.replace('.png', '-720.png')) })
  report.push({ file: f, ...stats })
}
await browser.close()
console.log(JSON.stringify(report, null, 2))