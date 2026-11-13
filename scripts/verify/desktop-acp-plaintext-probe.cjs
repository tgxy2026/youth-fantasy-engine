// 3.5.4 · 桌面 ACP 纯文本入口联调（假 Agent · 真实 Electron 主进程 IPC）
//
// 做法：把本次构建的 dist / electron / scripts 复制到隔离目录，仅把
// scripts/agent-host/antigravity-adapter.mjs 换成启动合成 Agent 的适配器；
// 通过 Playwright 启动真实 Electron，经 preload 暴露的 electronAgentHost /
// electronAcp 调用主进程，验证：
//   · 七个纯文本任务标识被 acp:generate 白名单接受并完成流式返回；
//   · 未知任务标识被拒绝；
//   · 取消能命中 acp:cancel，取消结果不可用。
// 不打开真实 ACP 连接、不写主人书库、不发网络模型请求。
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..', '..')
const FAKE_AGENT = path.join(ROOT, 'tests', 'fixtures', 'fake-acp-agent.mjs')
const TASKS = ['continuation', 'rewrite', 'diagnosis', 'pleasure', 'opening', 'briefing', 'summary']
let pass = 0, fail = 0
const ok = (name, condition, detail = '') => {
  if (condition) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail ? ':: ' + detail : '') }
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name), to = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else await fsp.copyFile(from, to)
  }
}

function fakeAdapter() {
  return `import { spawn } from 'node:child_process'
export function createAntigravityAdapter() {
  return {
    id: 'antigravity', name: 'Antigravity',
    async launch({ cwd }) {
      const child = spawn(process.execPath, [${JSON.stringify(FAKE_AGENT)}], {
        cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.on('error', () => {})
      const exited = new Promise(resolve => child.once('close', resolve))
      return {
        input: child.stdin, output: child.stdout, exited,
        async stop() { child.kill(); await exited },
      }
    },
  }
}
`
}

async function main() {
  const runRoot = await fsp.mkdtemp(path.join(ROOT, '.workbuddy', 'tmp', '354-plaintext-desktop-'))
  const appDir = path.join(runRoot, 'app')
  const profile = path.join(runRoot, 'profile')
  for (const name of ['dist', 'electron', 'scripts']) await copyDir(path.join(ROOT, name), path.join(appDir, name))
  await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'))
  await fsp.writeFile(path.join(appDir, 'scripts', 'agent-host', 'antigravity-adapter.mjs'), fakeAdapter())

  const electronPath = require('electron')
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [appDir, `--user-data-dir=${profile}`],
    env: { ...process.env, YFE_ACP_PROBE: '1' },
    timeout: 60_000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const switched = await page.evaluate(async () => {
      return await window.electronAgentHost.modeSwitch({ to: 'acp', transitionId: 'probe-acp-switch' })
    })
    ok('桌面切换到 ACP 模式', switched && switched.ok === true && switched.status && switched.status.mode === 'acp', JSON.stringify(switched))
    const status = await page.evaluate(async () => await window.electronAcp.status())
    ok('主进程返回假 Agent 状态', status && status.generation && status.selected === 'antigravity', JSON.stringify(status))

    for (const task of TASKS) {
      const result = await page.evaluate(async ({ task, generation }) => {
        return await window.electronAcp.generate({
          id: `probe-${task}`, task, generation, text: '【本章正文】合成正文，请输出纯文本结果。',
        })
      }, { task, generation: status.generation })
      ok(`${task} 经桌面 IPC 与假 Agent 完成`, result && result.ok === true && result.text === '合成作品', JSON.stringify(result))
    }

    const unknown = await page.evaluate(async ({ generation }) => {
      return await window.electronAcp.generate({ id: 'probe-unknown', task: 'structure', generation, text: 'x' })
    }, { generation: status.generation })
    ok('未知任务标识被主进程拒绝', unknown && unknown.ok === false && /无效/.test(unknown.error || ''), JSON.stringify(unknown))

    const cancelled = await page.evaluate(async ({ generation }) => {
      const id = 'probe-cancel'
      const chunks = []
      const off = window.electronAcp.onChunk(chunk => { if (chunk.id === id) chunks.push(chunk.delta) })
      const pending = window.electronAcp.generate({ id, task: 'summary', generation, text: 'cancel' })
      await new Promise(resolve => setTimeout(resolve, 400))
      const hit = await window.electronAcp.cancel(id)
      const result = await pending
      off()
      return { hit, result, chunks }
    }, { generation: status.generation })
    ok('取消命中 acp:cancel', cancelled && cancelled.hit === true, JSON.stringify(cancelled))
    ok('取消结果不可用', cancelled && cancelled.result && cancelled.result.ok === false, JSON.stringify(cancelled))
    ok('取消后不再交付迟到分片', !cancelled.chunks.includes('取消后片段'), JSON.stringify(cancelled.chunks))

    const back = await page.evaluate(async () => {
      return await window.electronAgentHost.modeSwitch({ to: 'api', transitionId: 'probe-api-switch' })
    })
    ok('联调后切回 API 模式', back && back.ok === true && back.status && back.status.mode === 'api', JSON.stringify(back))
    console.log(`artifact=${runRoot}`)
  } finally {
    await app.close()
  }
  console.log(`DESKTOP_ACP_PLAINTEXT samples=${pass + fail} passed=${pass} failed=${fail}`)
  if (fail) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
