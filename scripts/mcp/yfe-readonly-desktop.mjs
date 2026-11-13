#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadonlyTools, serveReadonlyBridge, desktopUserDataDir, parseArgs, resolveDataFile } from '../agent-host/readonly-tools.mjs'

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const hostIndex = argv.indexOf('--host-file')
const hostFile = hostIndex < 0
  ? path.join(desktopUserDataDir(), 'agent-host.json')
  : argv[hostIndex + 1]

serveReadonlyBridge({
  tools: createReadonlyTools('').tools,
  async invoke(tool, parameters) {
    if (args.portableRoot) throw new Error('便携数据请使用便携包中的 MCP 桥。')
    if (!hostFile || !path.isAbsolute(hostFile)) throw new Error('MCP 宿主配置路径无效。')
    let host
    try { host = JSON.parse(await fs.readFile(hostFile, 'utf8')) }
    catch { throw new Error('请打开桌面引擎并在 MCP 模式配置连接。') }
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535 || typeof host.token !== 'string') {
      throw new Error('MCP 宿主未就绪。')
    }
    const res = await fetch(`http://127.0.0.1:${host.port}/api/agent/readonly`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool, parameters, dataFile: args.dataFile ? resolveDataFile(args) : null }),
    })
    const result = await res.json()
    if (!res.ok || result.ok !== true) throw new Error(result.error || 'MCP 读取失败。')
    return result.value
  },
})
