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

/** 给外部 Agent 的连接说明只含路径和参数，不读取或嵌入宿主令牌。 */
export function makeAgentConnectionPrompt(nodeCommand: string, script: string, source: AgentHostSource): string {
  const { node, args } = agentBridgeSpec(nodeCommand, script, source)
  const bridge = script.trim()
  const specPath = /scripts[\\/]mcp[\\/]yfe-agent\.mjs$/i.test(bridge)
    ? bridge.replace(/scripts[\\/]mcp[\\/]yfe-agent\.mjs$/i, 'docs/3.4.3-MCP第三方开发者适配规范.md') : ''
  return [
    '请将本机青春幻想引擎连接为 MCP 工具服务，并保留现有客户端配置。',
    '引擎需要保持运行，并在「模型设置 → Agent 连接设置」开启连接、按项目和动作授权。',
    `可执行命令：${JSON.stringify(node)}`,
    `启动参数（按顺序）：${JSON.stringify(args)}`,
    ...(specPath ? [`第三方适配规范文件（如随发行包提供）：${JSON.stringify(specPath)}`] : []),
    '这是已有的 stdio MCP 桥；请按当前客户端的 MCP 配置方式使用上述命令和参数，优先复用已有配置，不要重新编写桥。',
    '不要读取、输出或分享宿主配置中的令牌，也不要复制作品数据。若当前客户端无法配置或加载 MCP，请说明原因和需要我完成的步骤。',
    '连接后先发现工具，并调用 yfe_host_info、yfe_list_projects 做只读验证；报告真实结果，不要假称成功。',
    '仅在我明确提出创作任务且引擎已授权对应项目和动作时写入；先读取当前内容和版本，遇冲突或结果不明先核对，不盲目重试。',
  ].join('\n')
}
