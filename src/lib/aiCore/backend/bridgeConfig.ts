/** Configuration text for a user-managed, local read-only MCP connection. */
export type BridgeDataSource = { kind: 'desktop'; dataFile?: string } | { kind: 'portable'; root: string } | { kind: 'file'; path: string }
export function makeBridgeConfig(nodeCommand: string, script: string, source: BridgeDataSource): string {
  const node = nodeCommand.trim()
  const bridge = script.trim()
  const absolute = (p: string) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
  if (!node) throw new Error('请填写 Node.js 命令或完整路径')
  if (!absolute(bridge)) throw new Error('请填写桥脚本的完整路径')
  const args = [bridge]
  if (source.kind === 'desktop' && source.dataFile) {
    if (!absolute(source.dataFile)) throw new Error('桌面版数据路径无效，请选择指定数据文件')
    args.push('--data-file', source.dataFile)
  } else if (source.kind === 'portable') {
    const root = source.root.trim()
    if (!absolute(root)) throw new Error('请填写便携版根目录的完整路径')
    args.push('--portable-root', root)
  } else if (source.kind === 'file') {
    const file = source.path.trim()
    if (!absolute(file)) throw new Error('请填写数据文件的完整路径')
    args.push('--data-file', file)
  }
  return JSON.stringify({ mcpServers: { 'yfe-readonly': { command: node, args } } }, null, 2)
}

/**
 * 可写工具桥的 MCP 配置（3.4.3）。
 *
 * 与只读桥的区别：桥不直接读数据文件，而是连**正在运行的引擎宿主**。
 * 因此配置指向宿主文件 `agent-host.json`（含随机 token），而不是作品数据文件。
 * 桌面版宿主文件在 userData（界面上由主进程返回），便携版在 `<根目录>/data/` 下。
 */
export type AgentHostSource = { kind: 'hostFile'; path: string } | { kind: 'portable'; root: string }

function agentBridgeSpec(nodeCommand: string, script: string, source: AgentHostSource): { node: string; args: string[] } {
  const node = nodeCommand.trim()
  const bridge = script.trim()
  const absolute = (p: string) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
  if (!node) throw new Error('请填写 Node.js 命令或完整路径')
  if (!absolute(bridge)) throw new Error('请填写可写桥脚本的完整路径')
  const args = [bridge]
  if (source.kind === 'hostFile') {
    const file = source.path.trim()
    if (!absolute(file)) throw new Error('请填写宿主配置文件的完整路径')
    args.push('--host-file', file)
  } else {
    const root = source.root.trim()
    if (!absolute(root)) throw new Error('请填写便携版根目录的完整路径')
    args.push('--portable-root', root)
  }
  return { node, args }
}

export function makeAgentBridgeConfig(nodeCommand: string, script: string, source: AgentHostSource): string {
  const { node, args } = agentBridgeSpec(nodeCommand, script, source)
  return JSON.stringify({ mcpServers: { 'yfe-agent': { command: node, args } } }, null, 2)
}

/** Codex 使用 TOML；JSON 字符串转义同时符合 TOML 基本字符串的转义要求。 */
export function makeCodexAgentBridgeConfig(nodeCommand: string, script: string, source: AgentHostSource): string {
  const { node, args } = agentBridgeSpec(nodeCommand, script, source)
  return `[mcp_servers.yfe_agent]\ncommand = ${JSON.stringify(node)}\nargs = [${args.map(value => JSON.stringify(value)).join(', ')}]\n`
}
