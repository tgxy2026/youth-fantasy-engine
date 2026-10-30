// 并发自检子进程：以同一基线提交一次，把自己的结果打到 stdout
import { commitProjectSnapshot, PROTOCOL_VERSION } from '../../server/lib/projectStore.mjs'

const [root, pid, opId, baseRevision, hash] = process.argv.slice(2)
const r = commitProjectSnapshot({
  root, pid, accountId: 'acc_1', opId,
  baseRevision: Number(baseRevision),
  manifest: {
    protocol: PROTOCOL_VERSION, createdAt: Date.now(),
    objects: [{ kind: 'chapters', hash, bytes: 15 }], assets: [], tombstones: [],
  },
})
process.stdout.write(JSON.stringify(r))
