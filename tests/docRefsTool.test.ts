import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../scripts/verify/process.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-doc-ref-clone-'))
try {
  await fs.mkdir(path.join(root, 'scripts/verify'), { recursive: true }); await fs.mkdir(path.join(root, 'docs')); await fs.mkdir(path.join(root, 'public'))
  await fs.copyFile('scripts/verify/check-doc-refs.cjs', path.join(root, 'scripts/verify/check-doc-refs.cjs'))
  await fs.writeFile(path.join(root, 'README.md'), '`public/kept.json` 和 `kept.json`')
  await fs.writeFile(path.join(root, 'public/kept.json'), 'fixture')
  const run = (args: string[]) => runProcess(process.execPath, [path.join(root, 'scripts/verify/check-doc-refs.cjs'), ...args], { cwd: os.tmpdir(), timeoutMs: 30000 })
  const clean = await run(['--inuse'])
  assert.ok(clean.ok && /（真失效）：0 处/.test(clean.out) && /可判定引用 2 处/.test(clean.out))
  console.log('PASS 无工作记忆目录且从其他cwd执行可定位克隆自身')
  await fs.writeFile(path.join(root, 'docs/current.md'), '`public/missing.json`')
  const missing = await run(['--root', root, '--inuse'])
  assert.ok(missing.ok && /（真失效）：1 处/.test(missing.out) && missing.out.includes('public/missing.json'))
  console.log('PASS 报出真实缺引用，保留现有报告口径')
  const invalid = await run(['--root'])
  assert.ok(!invalid.ok)
  console.log('PASS 缺根目录参数失败关闭')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-doc-ref-clone-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
