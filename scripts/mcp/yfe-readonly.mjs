#!/usr/bin/env node
// ============ 青春幻想引擎 · 只读 MCP 数据桥（3.4.3 · P2）============
//
// 让外部 Agent（MCP client）以**只读**方式读取本机桌面版 / 便携版的数据文件：
// 项目 / 章节 / 设定卡 / 表格 / 表单 / 灵感夹。stdio 传输、仅本机、零依赖（手写 JSON-RPC 子集）。
//
// 🔴 只读红线（规划 §P2）：
//   · 本进程对数据文件**只有 readFileSync / existsSync / statSync**，没有任何写路径；
//     外部 Agent 回写一律走「导出项目包 → 导入」通道，禁止经本桥写库。
//   · 白名单暴露：每个工具的输出都由**显式字段名单**构造，绝不整条展开记录 ——
//     将来记录新增敏感字段也不会默认漏出。
//   · meta store 整体不暴露（aiProviders 里有明文 apiKey）；settingsKV 只放行
//     `<projectId>::inspirationBox` 这一个键；备份 / 快照 / 回收站 / 向量 / 知识库一律不暴露。
//   · 不引入任何凭证：不读 desktop-session.bin，不碰密钥，stdout 只走协议帧。
//
// 用法：
//   node scripts/mcp/yfe-readonly.mjs --data-file <数据文件.json>
//   node scripts/mcp/yfe-readonly.mjs --portable-root <便携版根目录>
//   node scripts/mcp/yfe-readonly.mjs            # 默认找桌面版 userData（含自定义路径配置）
//
// 网页版没有本机数据文件 ⇒ 找不到文件时工具如实报错「网页版不可用」，绝不伪造空数据。

import { createReadonlyTools, serveReadonlyBridge, parseArgs, resolveDataFile } from '../agent-host/readonly-tools.mjs'

serveReadonlyBridge(createReadonlyTools(resolveDataFile(parseArgs(process.argv.slice(2)))))
