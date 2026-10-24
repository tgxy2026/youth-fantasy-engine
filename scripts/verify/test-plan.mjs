import fs from 'node:fs'
import path from 'node:path'

// The shell manifest remains the sole A/B/C/D membership source.
export function readTestPlan(root, requested = ['all']) {
  const tests = path.join(root, 'tests')
  const manifest = fs.readFileSync(path.join(tests, 'run-batches.sh'), 'utf8')
  const batches = new Map()
  for (const match of manifest.matchAll(/^BATCH_([A-D])="([^"]*)"\r?$/gm)) {
    if (batches.has(match[1])) throw new Error(`Duplicate batch ${match[1]}`)
    batches.set(match[1], match[2].trim().split(/\s+/).filter(Boolean))
  }
  if (batches.size !== 4) throw new Error('Batch manifest must define A/B/C/D exactly once')
  const declared = [...batches.values()].flat()
  const actual = fs.readdirSync(tests).filter(name => name.endsWith('.test.ts')).map(name => name.slice(0, -8))
  const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index)
  const missing = actual.filter(name => !declared.includes(name))
  const ghosts = declared.filter(name => !actual.includes(name))
  if (duplicates.length || missing.length || ghosts.length || actual.length === 0) {
    throw new Error(`Invalid test manifest: duplicates=${duplicates.join(',')} unbatched=${missing.join(',')} missing=${ghosts.join(',')} actual=${actual.length}`)
  }
  const selection = requested.length ? requested : ['all']
  if (selection.includes('all') && selection.length !== 1) throw new Error('all cannot be combined with other batches')
  const ids = selection[0] === 'all' ? ['A', 'B', 'C', 'D'] : selection
  if (new Set(ids).size !== ids.length || ids.some(id => !batches.has(id))) throw new Error('Select distinct batches A/B/C/D or all')
  const jobs = ids.flatMap(batch => batches.get(batch).map(id => ({ id, batch, file: 'build-test.mjs', args: [id] })))
  if (ids.length === 4) {
    for (const file of ['seed-schema-check.mjs', 'feature-deps-check.mjs']) {
      if (!fs.existsSync(path.join(tests, file))) throw new Error(`Missing standalone gate ${file}`)
      jobs.push({ id: file.slice(0, -4), batch: 'standalone', file, args: [] })
    }
  }
  return { batchIds: ids, actualEntries: actual.length, jobs }
}
