// Isolated browser check: portable community must not contact a local or remote API.
import { createServer } from 'vite'
import { chromium } from 'playwright'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  let requests = 0
  page.on('request', (request) => { if (request.url().includes('/api/community/')) requests++ })
  await page.goto(`http://127.0.0.1:${address.port}/tests/browser/community.html?portable=1`)
  await page.getByText('便携版暂不支持社区连接', { exact: false }).waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(300)
  if (requests !== 0) throw new Error(`便携版意外请求社区接口 ${requests} 次`)
  console.log('PASS 便携版显示不可用，联网事件后仍不请求社区接口')
} finally {
  await browser?.close()
  await server.close()
}
