import type { HelpArticle } from '@/lib/help/types'

export const AGENT_BACKEND_ARTICLES: HelpArticle[] = [{
  id: 'agent-backend', revision: 3,
  title: '外部 Agent 协作：只读数据桥与写入工具',
  summary: '让外部 MCP 客户端读取本机作品；开启并授权后，也可创建设定与录入正文。',
  aliases: ['Agent 后端', '只读数据桥', 'MCP', 'Agent 写作', '创建设定', '录入正文'],
  keywords: ['Agent', 'MCP', '只读', '写入', '授权', '桌面版', '便携版', '数据桥'],
  group: '模型与 AI', tabIds: ['model-settings'], availability: 'all', aiRequirement: 'none',
  sections: [
    { id: 'status', heading: '当前可用范围', body: [
      '外部 Agent 软件可以通过只读数据桥获取引擎中已保存的作品资料。原有模型接口仍可使用，二者互不影响。',
      '桌面版与便携版还可以开启「Agent 写入连接」：授权后，外部 Agent 能直接创建设定卡、创建章节、追加或覆盖正文。写入默认关闭；未在引擎里勾选的项目与动作一律拒绝。网页版没有本机宿主进程，只能使用原有模型接口。',
    ] },
    { id: 'connect', heading: '连接本机数据（只读）', body: [
      '需要本机 Node.js 和支持 stdio 的 MCP 客户端。在客户端添加服务，命令设为 node，参数使用桥脚本的绝对路径。桌面安装版脚本位于安装目录下 resources/scripts/mcp/yfe-readonly.mjs；便携版位于 scripts/mcp/yfe-readonly.mjs。',
      '默认读取桌面版数据及其自定义数据路径。读取便携版时，在脚本路径之后添加 --portable-root 和便携版根目录；也可用 --data-file 指定数据文件的完整路径。客户端配置格式请参照所用软件的说明。',
    ] },
    { id: 'write', heading: '开启写入连接', body: [
      '在「模型设置 → 外部 Agent 协作 → Agent 写入连接」勾选「开启 Agent 写入连接」，再按项目勾选允许的动作：创建设定卡、创建章节、追加 / 覆盖正文。保存后，把生成的 yfe-agent 配置合并进客户端的 mcpServers。',
      '写入必须进入正在运行的引擎：桌面版由应用主进程转发，便携版由本地服务转发给当前页面。请保持引擎运行并打开要写入的作品；外部进程不会、也不能直接改数据文件。',
      '可写桥脚本位于 resources/scripts/mcp/yfe-agent.mjs（桌面安装版）或 scripts/mcp/yfe-agent.mjs（便携版）。桌面版配置用 --host-file 指向「模型设置」显示的宿主配置文件；便携版用 --portable-root 指向便携版根目录。',
    ] },
    { id: 'safety', heading: '写入规则与保护', body: [
      '每个写请求必须带 requestId；相同 requestId 重试不会重复建卡或重复追加。宿主会记录每次请求的状态：成功、失败、处理中，或「结果不明」。结果不明时请先在引擎里核对，不要盲目重试。',
      '追加 / 覆盖正文前会保留一版可恢复快照；存在未保存的编辑草稿时会拒绝写入，避免覆盖作者正在修改的内容。章节写入使用 updatedAt 版本前置条件，版本不符会返回冲突与当前版本，需重新读取后再试。',
      '外部 Agent 只能操作当前打开的项目；它不是模型接口的替代品，不会读取或转发任何登录凭据，也不会自动运行无人值守循环。',
    ] },
    { id: 'limits', heading: '数据范围与限制', body: [
      '只读桥只读取已保存到数据文件的项目、章节、设定和灵感等白名单数据；请先在引擎中保存。它不暴露模型密钥、备份或快照。请只连接你信任的客户端。',
      '写入连接只开放设定卡栏目（主要角色 / 次要角色 / NPC / 其他设定 / 分卷大纲 / 章节细纲）与章节正文，不开放删除作品、通用脚本执行或任意数据库读写。项目包导入仍会创建新项目，不会覆盖原项目。',
      '宿主配置文件包含本机随机连接令牌，请勿分享或提交到仓库。网页版、未开启连接、未授权的项目与动作都会被失败关闭。',
    ] },
  ],
  related: ['faq-multi-protocol'], actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
  verifiedAgainst: '3.4.3', reviewedAt: '2026-11-08',
}]