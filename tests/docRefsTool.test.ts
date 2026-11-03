import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../scripts/verify/process.mjs'

// 🔴 fixture 的目录名必须走变量：sourcePathGuard 会把测试里 `'src/…'` 字面量当成仓库内真实路径来查
const SRC = 'src'
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

  // ============ 3.3.3 · B2：源码注释里的文档路径门禁（--source）============
  //
  // 🔴 全部样本造在临时目录里，绝不在真实源码里制造坏引用。
  // 🔴 退出码语义：0 通过 / 1 确定失效 / 2 工具异常 —— 2 绝不能当绿灯。

  // B2-a：有真实文档 + 注释引用 ⇒ 通过
  await fs.mkdir(path.join(root, SRC), { recursive: true })
  await fs.writeFile(path.join(root, 'docs/src-ok.md'), '# ok')
  await fs.writeFile(path.join(root, SRC, 'good.ts'), '// 口径见 docs/src-ok.md 第 2 节\nexport const a = 1\n')
  const srcClean = await run(['--source', '--root', root])
  assert.ok(srcClean.ok && /（真失效）：0 处/.test(srcClean.out), srcClean.out)
  console.log('PASS 源码注释引用有效 ⇒ 退出 0、报 0 处失效')

  // B2-b：中文路径 / 含空格（反引号包裹） / 带行号 / 带锚点 都算有效
  await fs.writeFile(path.join(root, 'docs/中文方案.md'), '# 中文')
  await fs.writeFile(path.join(root, 'docs/has space.md'), '# 空格')
  await fs.writeFile(path.join(root, SRC, 'cjk.ts'), [
    '// 见 docs/中文方案.md §3',
    '// 见 `docs/has space.md`（反引号包裹可含空格）',
    '// 见 docs/src-ok.md:120 与 docs/src-ok.md#L42',
    'export const b = 2',
  ].join('\n'))
  const srcShapes = await run(['--source', '--root', root])
  assert.ok(srcShapes.ok && /（真失效）：0 处/.test(srcShapes.out), srcShapes.out)
  console.log('PASS 中文/空格/行号/锚点四种写法均识别为有效')

  // B2-c：确定失效 ⇒ 非零退出 + 给出文件与行号
  await fs.writeFile(path.join(root, SRC, 'bad.ts'), '// 这份文档已经被归档了 docs/已归档的方案.md\nexport const c = 3\n')
  const srcBad = await run(['--source', '--root', root])
  assert.ok(!srcBad.ok && srcBad.exitCode === 1, `exit=${srcBad.exitCode}`)
  assert.ok(/（真失效）：1 处/.test(srcBad.out) && srcBad.out.includes(`${SRC}/bad.ts`) && /:1\s+docs\/已归档的方案\.md/.test(srcBad.out), srcBad.out)
  console.log('PASS 失效引用 ⇒ 退出 1，并给出文件与行号')
  await fs.rm(path.join(root, SRC, 'bad.ts'))

  // B2-d：字符串 / URL / 通配 / 占位 / 模板串 均不误报
  await fs.writeFile(path.join(root, SRC, 'noise.ts'), [
    'export const p = "docs/字符串里的不算.md"',
    "export const u = 'https://example.com/docs/url里的不算.md'",
    'const t = `模板串里的 docs/模板里不算.md`',
    '// 模板写法 docs/*.md 与 docs/<名字>.md 不算引用',
    '// 占位 docs/xxx.md 与 docs/X.Y.Z-说明.md 也不算',
    '// 只有上一行的 docs/src-ok.md 是真实引用',
  ].join('\n'))
  const srcNoise = await run(['--source', '--root', root])
  assert.ok(srcNoise.ok && /（真失效）：0 处/.test(srcNoise.out), srcNoise.out)
  console.log('PASS 字符串/URL/通配/占位/模板串 ⇒ 不误报')
  await fs.rm(path.join(root, SRC, 'noise.ts'))

  // B2-e：根下没有任何可扫目录 ⇒ 退出 2（工具异常不能当绿灯）
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-doc-ref-empty-'))
  await fs.mkdir(path.join(emptyRoot, 'docs'))
  await fs.writeFile(path.join(emptyRoot, 'docs/only.md'), '# 只有文档')
  const srcEmpty = await runProcess(process.execPath, [path.join(root, 'scripts/verify/check-doc-refs.cjs'), '--source', '--root', emptyRoot], { cwd: os.tmpdir(), timeoutMs: 30000 })
  const emptyReal = await fs.realpath(emptyRoot)
  if (path.dirname(emptyReal) !== await fs.realpath(os.tmpdir()) || !path.basename(emptyReal).startsWith('yfe-doc-ref-empty-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(emptyReal, { recursive: true })
  assert.ok(!srcEmpty.ok && srcEmpty.exitCode === 2, `exit=${srcEmpty.exitCode}`)
  assert.ok(/视为工具异常/.test(srcEmpty.out), srcEmpty.out)
  console.log('PASS 扫不到源码 ⇒ 退出 2 并明说工具异常，不当绿灯')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-doc-ref-clone-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
