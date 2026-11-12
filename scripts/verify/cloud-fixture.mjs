// 仅用于测试临时资料目录：让自检账号按真实注册流程取得云同步资格。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const TEST_SYNC_INVITE = 'YFE-CHECK-352'
export function seedSyncInvite(dataDir) {
  writeFileSync(join(dataDir, 'users.json'), JSON.stringify({ version: 1, users: {}, invites: {
    [TEST_SYNC_INVITE]: { createdAt: Date.now(), maxUses: 3, uses: 0, note: '隔离自检', usedBy: [] },
  } }))
}
