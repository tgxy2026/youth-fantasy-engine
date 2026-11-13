// 两个独立进程竞争同一隔离账号；不访问用户数据。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { acquireAccountWriteLock } from '../../server/lib/v2Index.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-account-lock-'))
const url = pathToFileURL(path.resolve('server/lib/v2Index.mjs')).href
const program = `import {acquireAccountWriteLock} from ${JSON.stringify(url)}; const lock=acquireAccountWriteLock(process.argv[1], 'a'); if (!lock) process.exit(2); console.log('ready'); process.stdin.once('data', () => { lock.release(); process.exit(0) });`
const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['pipe', 'pipe', 'inherit'] })
try {
  const [chunk] = await once(child.stdout, 'data')
  assert.match(chunk.toString(), /ready/)
  assert.equal(acquireAccountWriteLock(root, 'a'), null)
  const another = acquireAccountWriteLock(root, 'b')
  assert.ok(another)
  another.release()
  const exited = once(child, 'exit')
  child.stdin.write('release')
  const [code] = await exited
  assert.equal(code, 0)
  const acquired = acquireAccountWriteLock(root, 'a')
  assert.ok(acquired)
  acquired.release()
  const interrupted = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['pipe', 'pipe', 'inherit'] })
  const [ready] = await once(interrupted.stdout, 'data')
  assert.match(ready.toString(), /ready/)
  const stopped = once(interrupted, 'exit')
  interrupted.kill('SIGKILL')
  await stopped
  assert.equal(acquireAccountWriteLock(root, 'a'), null, '进程中断后的残留锁必须阻止写入')
  console.log('PASS 两进程同账号互斥，不同账号独立，释放后可重试')
} finally {
  if (child.exitCode === null) child.kill()
  fs.rmSync(root, { recursive: true, force: true })
}
