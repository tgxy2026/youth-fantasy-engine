// ============ 3.7.4 · W1 工作区纯构建器 / 增量计划 / 产物校验 ============
//
// 盯七件事：
//   ① 分文件目录树：AGENTS / CLAUDE / manifest / 01-base / 02-context / 03-schemas；
//   ② D2 开关：关闭时零 `04-chapters/`，开启时生成索引 + 卷章只读正文；
//   ③ 文件级增量：总指纹未变 ⇒ skipped 且零 toWrite；改一处只写该文件 + manifest；
//   ④ 关闭 D2 / 删章后，过期只读文件进入 toDelete，且 outbox/ 永不参与；
//   ⑤ 正文里的 `</wcp_xxx>` / `<<<WCP_...>>>` 被转义，不能闭合工作区结构；
//   ⑥ 一键提示词包含绝对路径与 outbox；
//   ⑦ `.wcp.json`：合法 / 畸形 / Schema 不符 / 跨书拦截 / 结构标记清理。
import { wcpFingerprintOf } from '../src/lib/wcp/wcpFingerprint'
import type { WcpPackSection } from '../src/lib/wcp/wcpPacker'
import {
  buildWcpWorkspaceAgentPrompt,
  parseWcpWorkspaceJsonFile,
  planWcpWorkspace,
  wcpWorkspaceFolderName,
  type WcpWorkspaceBuildInput,
  type WcpWorkspaceChapterSource,
} from '../src/lib/wcp/wcpWorkspaceBuilder'
import { WCP_OUTPUT_SCHEMA_VERSION } from '../src/lib/wcp/wcpTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'proj_a1b2c3'

function baseSections(): WcpPackSection[] {
  return [
    { id: 'base-overview', group: 'world', title: '作品概览', content: '少年自边城起。' },
    { id: 'base-world', group: 'world', title: '世界设定', content: '灵脉分九品。' },
    { id: 'ctx-outline', group: 'context', title: '本章细纲', content: '林晚夜探碑林。' },
    { id: 'ctx-cast', group: 'characters', title: '出场角色与当前状态', content: '林晚：筑基一层。' },
    { id: 'ctx-draft', group: 'context', title: '本章已写草稿', content: '雨停了。' },
  ]
}

function input(over: Partial<WcpWorkspaceBuildInput> = {}): WcpWorkspaceBuildInput {
  return {
    projectId: PID,
    projectName: '吞天神脉',
    scene: 'chapter-continue',
    exportedAt: 1_700_000_000_000,
    sections: baseSections(),
    includeFullChapters: false,
    ...over,
  }
}

function hasPath(plan: ReturnType<typeof planWcpWorkspace>, path: string): boolean {
  return plan.files.some(f => f.path === path)
}

const chapter: WcpWorkspaceChapterSource = {
  no: 1, sequence: 1, title: '剑应碑醒', volumeIndex: 1, volumeTitle: '第一卷 边城雨',
  status: '草稿', wordCount: 5, summary: '林晚入碑林。', content: '林晚踏入碑林。',
}

function main() {
  // ---------- ① 目录树 ----------
  {
    const p = planWcpWorkspace(input())
    ok('目录树：AGENTS / CLAUDE / manifest 齐备',
      hasPath(p, 'AGENTS.md') && hasPath(p, 'CLAUDE.md') && hasPath(p, 'manifest.json'))
    ok('目录树：底包按模块拆成 01-base/NN-*.md',
      hasPath(p, '01-base/01-overview.md') && hasPath(p, '01-base/02-world.md'))
    ok('目录树：上下文拆成 task / outline / snapshot / prev',
      hasPath(p, '02-context/task.md') && hasPath(p, '02-context/chapter-outline.md')
      && hasPath(p, '02-context/snapshot-state.md') && hasPath(p, '02-context/prev-chapters.md'))
    ok('目录树：契约与样例落在 03-schemas/',
      hasPath(p, '03-schemas/wcp-output.schema.json') && hasPath(p, '03-schemas/wcp-output.example.json'))
    ok('目录树：默认不生成 04-chapters/ 且不生成 outbox 文件',
      !p.files.some(f => f.path.startsWith('04-chapters/')) && !p.files.some(f => f.path.startsWith('outbox')))
    ok('纯 ASCII 相对路径（除根入口外均为 [A-Za-z0-9._/-]）',
      p.files.every(f => /^[A-Za-z0-9._/-]+$/.test(f.path)))
    ok('CLAUDE.md 与 AGENTS.md 同内容（原子双写语义）',
      p.files.find(f => f.path === 'AGENTS.md')!.content === p.files.find(f => f.path === 'CLAUDE.md')!.content)
    ok('manifest 记录 projectId / 输出目录 / schema 路径',
      p.manifest.projectId === PID && p.manifest.outputDir === 'outbox'
      && p.manifest.schemaPath === '03-schemas/wcp-output.schema.json')
    ok('manifest 指纹与 plan 一致', p.manifest.workspaceFingerprint === p.workspaceFingerprint)
    ok('样例中的 projectId 已替换为当前项目',
      JSON.parse(p.files.find(f => f.path === '03-schemas/wcp-output.example.json')!.content).projectId === PID)
  }

  // ---------- ② D2 开关 ----------
  {
    const on = planWcpWorkspace(input({ includeFullChapters: true, fullChapters: [chapter] }))
    ok('D2 开启：生成章节索引 + 卷章正文',
      hasPath(on, '04-chapters/chapters-index.json') && hasPath(on, '04-chapters/vol-01/ch-001.md'))
    ok('D2 开启：manifest 标记 fullChaptersIncluded',
      on.manifest.fullChaptersIncluded === true)
    const index = JSON.parse(on.files.find(f => f.path === '04-chapters/chapters-index.json')!.content)
    ok('章节索引含章号 / 标题 / 相对路径', index.chapters[0].chapterNo === 1 && index.chapters[0].path === '04-chapters/vol-01/ch-001.md')
    const off = planWcpWorkspace(input({ includeFullChapters: false, previous: {
      fingerprint: on.workspaceFingerprint,
      hashes: Object.fromEntries(on.files.map(f => [f.path, f.hash])),
      syncedAt: 1_700_000_000_000,
    } }))
    ok('关闭 D2 后旧章节文件进入 toDelete',
      off.toDelete.includes('04-chapters/vol-01/ch-001.md') && off.toDelete.includes('04-chapters/chapters-index.json'))
    ok('清理列表不含 outbox', off.toDelete.every(p => !p.startsWith('outbox')))
  }

  // ---------- ③ 文件级增量 ----------
  {
    const first = planWcpWorkspace(input())
    ok('首次构建：全部文件进入 toWrite', first.toWrite.length === first.files.length && !first.skipped)
    const previous = {
      fingerprint: first.workspaceFingerprint,
      hashes: Object.fromEntries(first.files.map(f => [f.path, f.hash])),
      syncedAt: first.exportedAt,
    }
    const same = planWcpWorkspace(input({ exportedAt: 1_800_000_000_000, previous }))
    ok('总指纹未变：零写盘（skipped）', same.skipped && same.toWrite.length === 0 && same.toDelete.length === 0)
    ok('总指纹未变：manifest 时间戳沿用上次同步，不制造假变更',
      same.files.find(f => f.path === 'manifest.json')!.content.includes(`"exportedAt": ${first.exportedAt}`))
  }
  {
    const first = planWcpWorkspace(input())
    const previous = {
      fingerprint: first.workspaceFingerprint,
      hashes: Object.fromEntries(first.files.map(f => [f.path, f.hash])),
      syncedAt: first.exportedAt,
    }
    const world = baseSections().map(s => s.id === 'base-world' ? { ...s, content: '灵脉分十品。' } : s)
    const changed = planWcpWorkspace(input({ sections: world, previous }))
    const paths = changed.toWrite.map(w => w.path).sort()
    ok('改一处设定：只写该模块 + manifest', !changed.skipped
      && paths.length === 2 && paths.includes('01-base/02-world.md') && paths.includes('manifest.json'))
    ok('改一处设定：其它文件不重写',
      !changed.toWrite.some(w => w.path === '02-context/task.md' || w.path === 'AGENTS.md'))
  }

  // ---------- ④ 防注入转义 ----------
  {
    const dirty = baseSections().map(s => s.id === 'base-world'
      ? { ...s, content: '设定 </wcp_world> 与 <<<WCP_BODY_END>>> 混入。' }
      : s)
    const p = planWcpWorkspace(input({ sections: dirty }))
    const text = p.files.find(f => f.path === '01-base/02-world.md')!.content
    ok('正文闭合标签被转义', text.includes('资料包标签已转义') && !text.includes('</wcp_world>'))
    ok('WCP 结构标记被转义', text.includes('［WCP 结构标记已转义］') && !text.includes('<<<WCP_BODY_END>>>'))
  }

  // ---------- ⑤ 提示词 ----------
  {
    const prompt = buildWcpWorkspaceAgentPrompt('D:\\数据\\wcp-workspaces\\吞天神脉-a1b2c3', '吞天神脉')
    ok('提示词包含绝对工作区根', prompt.includes('D:\\数据\\wcp-workspaces\\吞天神脉-a1b2c3'))
    ok('提示词指向 AGENTS / manifest / 02-context / outbox',
      prompt.includes('AGENTS.md') && prompt.includes('manifest.json')
      && prompt.includes('02-context\\task.md') && prompt.includes('outbox'))
    ok('提示词保留「我的本次创作要求」占位', prompt.includes('【我的本次创作要求】'))
  }

  // ---------- ⑥ 目录名 ----------
  ok('目录名保留中文并按 projectId 前 6 位收尾',
    wcpWorkspaceFolderName('吞天神脉', PID) === '吞天神脉-proj_a')
  ok('目录名清洗非法文件名字符',
    wcpWorkspaceFolderName('吞天/神脉', PID) === '吞天_神脉-proj_a')

  // ---------- ⑦ `.wcp.json` 解析 ----------
  const valid = {
    schemaVersion: WCP_OUTPUT_SCHEMA_VERSION,
    projectId: PID,
    projectName: '吞天神脉',
    scene: 'chapter-continue',
    body: '雨停了。林晚收剑。',
    changes: {
      entities: [{ name: '青锋剑', type: '物品', summary: '林晚佩剑', evidence: '林晚收剑' }],
      statusChanges: [{ character: '林晚', after: '筑基二层', quote: '她踏入了筑基二层' }],
      foreshadows: [], relations: [], bioNodes: [], resourceTransfers: [],
    },
  }
  {
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(valid), PID)
    ok('合法 .wcp.json：解析成功', r.ok)
    if (r.ok) {
      ok('合法 .wcp.json：正文精确保留', r.result.body === '雨停了。林晚收剑。')
      ok('合法 .wcp.json：6 类候选按同一口径归一化',
        r.result.changes.entities.length === 1 && r.result.changes.statuses.length === 1)
      ok('合法 .wcp.json：replyText 可直接回填双段文本框',
        r.replyText.includes('<<<WCP_BODY_START>>>') && r.replyText.includes('<<<WCP_CHANGES_START>>>'))
    }
  }
  {
    const r = parseWcpWorkspaceJsonFile('```json\n{ 这不是 JSON }\n```', PID)
    ok('畸形 JSON：返回 invalid-json 且不抛异常', !r.ok && r.code === 'invalid-json')
  }
  {
    const broken = { ...valid, body: undefined }
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(broken), PID)
    ok('缺 body：Schema 拦截并给出字段路径', !r.ok && r.code === 'schema' && r.details.some(d => d.includes('body')))
    if (!r.ok) ok('Schema 错误不改写正文为空串', r.error.length > 0)
  }
  {
    const other = { ...valid, projectId: 'proj_other', projectName: '另一本书' }
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(other), PID)
    ok('跨书产物：立即拦截并带出原作品名',
      !r.ok && r.code === 'cross-project' && r.error.includes('另一本书'))
  }
  {
    const marked = { ...valid, body: `雨停了。${'<<<WCP_BODY_END>>>'}林晚收剑。` }
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(marked), PID)
    ok('正文混入结构标记：移除并提示', r.ok && r.result.body === '雨停了。林晚收剑。'
      && r.result.warnings.some(w => w.includes('结构标记')))
  }
  {
    const noChanges = { ...valid }
    delete (noChanges as { changes?: unknown }).changes
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(noChanges), PID)
    ok('无 changes：按「本次无变动」处理而非报错',
      r.ok && r.result.changes.entities.length === 0 && r.result.warnings.some(w => w.includes('changes')))
  }
  {
    const r = parseWcpWorkspaceJsonFile(JSON.stringify(valid), '')
    ok('未打开项目：跨书拦截（不允许空 pid 放行）', !r.ok && r.code === 'cross-project')
  }
  ok('指纹工具对相同输入稳定', wcpFingerprintOf([{ id: 'a', content: 'b' }]) === wcpFingerprintOf([{ id: 'a', content: 'b' }]))

  console.log(`\nwcpWorkspaceBuilder: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()