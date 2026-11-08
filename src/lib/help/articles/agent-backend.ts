import type { HelpArticle } from '@/lib/help/types'

export const AGENT_BACKEND_ARTICLES: HelpArticle[] = [{
  id: 'agent-backend', revision: 1,
  title: 'Agent 后端与只读数据桥',
  summary: '了解 Agent 后端的当前状态，以及如何让外部 MCP 客户端只读本机项目。',
  aliases: ['Agent 后端', '只读数据桥', 'MCP'],
  keywords: ['Agent', 'MCP', '只读', '桌面版', '便携版', '数据桥'],
  group: '模型与 AI', tabIds: ['model-settings'], availability: 'all', aiRequirement: 'none',
  sections: [
    { id: 'status', heading: '当前可用范围', body: [
      'Agent 后端与普通模型接口是两条独立的后端轨道。目前没有内置真实 Agent 驱动；模型设置显示未配置时，不能通过该入口使用 Agent。原有模型接口仍可使用。',
      '只读数据桥可供外部支持 MCP 的软件使用，与引擎内的 Agent 后端配置是两回事。网页版没有可供桥读取的本机数据文件。',
    ] },
    { id: 'connect', heading: '连接本机数据', body: [
      '需要本机 Node.js 和支持 stdio 的 MCP 客户端。在客户端添加服务，命令设为 node，参数使用桥脚本的绝对路径。桌面安装版脚本位于安装目录下 resources/scripts/mcp/yfe-readonly.mjs；便携版位于 scripts/mcp/yfe-readonly.mjs。',
      '默认读取桌面版数据及其自定义数据路径。读取便携版时，在脚本路径之后添加 --portable-root 和便携版根目录；也可用 --data-file 指定数据文件的完整路径。客户端配置格式请参照所用软件的说明。',
    ] },
    { id: 'limits', heading: '数据范围与回写', body: [
      '桥只提供项目、章节、设定和灵感等白名单数据的读取，不提供写库功能，也不暴露模型密钥、备份或快照。请只连接你信任的客户端；它可以读取桥提供的创作内容。',
      '需要把外部修改带回引擎时，请使用项目包导出与导入流程。结构化 JSON 任务和自动链不会被强行交给 Agent 处理。',
    ] },
  ],
  related: ['faq-multi-protocol'], actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
  verifiedAgainst: '3.4.3', reviewedAt: '2026-11-08',
}]
