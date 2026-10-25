import { createHash } from 'node:crypto'

export const FIXTURE_NAMES = Object.freeze(['small', 'medium', 'large', 'tree', 'mixed', 'project-switch', 'longbook'])
export const FIXTURE_VERSION = 1
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const TIME = 1792800000000

// Definitions come from the current schema facade and atlas column resolver, supplied by the caller.
// No application storage or author data is consulted by this generator.
export function generateTableFixture(schema, name, seed = 323) {
  if (!FIXTURE_NAMES.includes(name) || !Number.isSafeInteger(seed) || seed < 0) throw new Error('Invalid fixture or seed')
  const tab = schema.tab
  if (tab.id !== 'races' || !tab.columns?.some(c => c.name === '名称')) throw new Error('Fixture requires current races schema')
  const count = name === 'small' ? 30 : ['medium', 'mixed', 'project-switch'].includes(name) ? 300 : name === 'longbook' ? 0 : 1000
  const fieldCount = ['small', 'longbook'].includes(name) ? 0 : 60
  const types = ['text', 'longText', 'number', 'select', 'multiSelect', 'boolean']
  const fields = Array.from({ length: fieldCount }, (_, i) => ({
    id: `cf_perf_${i}`, label: `性能字段${i + 1}`, type: types[i % types.length], description: '合成性能夹具',
    options: ['甲', '乙', '丙'], appliesTo: '*', groupId: 'extra', order: i,
    tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false,
  }))
  const config = { formatVersion: 1, revision: 1, fields, groups: [], builtinPresentation: {}, summaryKeys: [] }
  const columns = schema.columnsOf(tab, config).map(c => ({ key: c.name, type: c.type ?? 'text', label: c.atlasField?.label ?? c.name }))
  const projects = ['A', ...(name === 'project-switch' ? ['B'] : [])].map(suffix => ({
    id: `perf-${name}-${seed}-${suffix}`, name: `性能夹具 ${name} ${suffix}`, genre: '玄幻', intro: '仅合成数据', projectType: 'full', createdAt: TIME, updatedAt: TIME,
  }))
  const rows = [], settings = [], trees = {}
  for (const project of projects) {
    const names = Array.from({ length: count }, (_, i) => `${project.id}-条目${String(i + 1).padStart(4, '0')}`)
    for (let i = 0; i < count; i++) {
      const data = Object.fromEntries(columns.map(c => [c.key, '']))
      Object.assign(data, { 编号: `R${String(i + 1).padStart(4, '0')}`, 名称: names[i], 类别: '人族', 保密等级: 'B', 备注: `seed=${seed};row=${i}` })
      // Independent fixed four-level chains; parent references use the actual display name contract.
      const parent = name === 'tree' && i % 4 !== 0 ? i - 1 : -1
      data['上级'] = parent < 0 ? '' : names[parent]
      for (const [j, field] of fields.entries()) {
        data[field.id] = field.type === 'number' ? String((seed + i * 7 + j) % 1000)
          : field.type === 'boolean' ? String((i + j) % 2 === 0)
            : field.type === 'select' ? field.options[(i + j) % 3]
              : field.type === 'multiSelect' ? JSON.stringify(['甲', '乙'])
                : field.type === 'longText' ? `第${i + 1}行\n${'合成多行内容。'.repeat(8 + i % 3)}` : `样本${seed}-${i}-${j}`
      }
      if (name === 'mixed') data['备注'] = `2026-10-${String(i % 28 + 1).padStart(2, '0')}\n日期目前按文本存储；${'变高行。'.repeat(i % 8)}`
      const id = `${project.id}-row-${i}`
      rows.push({ id, projectId: project.id, tabId: tab.id, data, order: i, createdAt: TIME + i, updatedAt: TIME + i })
      trees[id] = parent < 0 ? null : `${project.id}-row-${parent}`
    }
    settings.push({ key: `${project.id}::atlasSchema::${tab.id}`, value: config })
  }
  const volumes = name === 'longbook' ? [{ id: 'perf-volume', projectId: projects[0].id, order: 0, title: '合成卷', description: '', createdAt: TIME }] : []
  const chapters = name === 'longbook' ? Array.from({ length: 500 }, (_, i) => ({
    id: `perf-ch-${i}`, projectId: projects[0].id, volumeId: volumes[0].id, order: i, title: `性能章${i + 1}`,
    content: (`性能第${i + 1}章：` + '这是一段合成正文，用来验证大表改造没有拖慢正文编辑。'.repeat(100)).slice(0, 2000),
    summary: '', status: '草稿', wordCount: 2000, createdAt: TIME + i, updatedAt: TIME + i,
  })) : []
  const revisionPayloads = name === 'longbook' ? Array.from({ length: 200 }, (_, i) => ({
    id: `perf-payload-${i}`, projectId: projects[0].id, kind: 'report', jobId: 'perf-offline', summary: `合成载荷${i}`,
    report: { checkId: 'chapter-check', source: 'local', result: [], evidence: [], chapterId: chapters[i].id }, bytes: 0, createdAt: TIME + i,
  })) : []
  // Persisted payload sizes are calculated from their actual synthetic content.
  for (const payload of revisionPayloads) payload.bytes = Buffer.byteLength(JSON.stringify(payload.report))
  const stores = { projects, tableRows: rows, settingsKV: settings, volumes, chapters, revisionPayloads, meta: [{ key: 'welcomeDone', value: '1' }] }
  const expected = {
    order: rows.map(r => r.id), parents: trees,
    filter: { key: '名称', query: '-条目0001', ids: rows.filter(r => r.data['名称'].endsWith('-条目0001')).map(r => r.id) },
    recordsHash: hash(rows), chapterChars: chapters.reduce((sum, c) => sum + c.content.length, 0),
  }
  const content = { version: FIXTURE_VERSION, name, seed, tab: { id: tab.id, name: tab.name, group: tab.group }, columns, stores, expected }
  return { ...content, manifest: { rows: rows.length, rowsPerProject: count, columns: columns.length, customFields: fields.length,
    projects: projects.length, chapters: chapters.length, payloads: revisionPayloads.length,
    bytes: Buffer.byteLength(JSON.stringify(content)), sha256: hash(content) } }
}
