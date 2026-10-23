import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
type Row = { level: string; item: string; detail: string }
const { checkArtifacts, checkLockVersion } = require(path.resolve('scripts/release-artifacts.cjs')) as {
  checkArtifacts: (root: string, version: string, opts?: { sourceOnly?: boolean; setupBytes?: number }) => { ready: boolean; rows: Row[] }
  checkLockVersion: (version: string, lock: unknown) => Row[]
}
let passed = 0
function check(name: string, value: boolean) {
  if (!value) throw new Error(name)
  passed++; console.log(`PASS ${name}`)
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-release-check-'))
function add(name: string) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture')
}
try {
  add('青春幻想引擎-便携版-3.2.1-Windows.zip')
  check('只有旧版包不能充当当前版产物', checkArtifacts(root, '3.2.2').rows.filter(r => r.level === 'FAIL').length === 3)
  const source = checkArtifacts(root, '3.2.2', { sourceOnly: true })
  check('源码检查允许未封装，但不报告产物准备完成', !source.ready && source.rows.every(r => r.level === 'INFO'))
  add('青春幻想引擎-便携版-3.2.2-Windows.zip')
  add('青春幻想引擎-便携版-3.2.2-macOS-Linux.zip')
  check('两份便携包不能掩盖安装包缺失', !checkArtifacts(root, '3.2.2').ready)
  add('桌面安装版/青春幻想引擎-Setup-3.2.2.exe')
  check('当前三件产物齐全，保留旧包不误报混版', checkArtifacts(root, '3.2.2').ready)
  check('安装包体积超限必须失败', !checkArtifacts(root, '3.2.2', { setupBytes: 2 }).ready)
  fs.writeFileSync(path.join(root, '桌面安装版/青春幻想引擎-Setup-3.2.2.exe'), '')
  check('空安装包不通过', !checkArtifacts(root, '3.2.2').ready)
  check('锁文件两处版本都要一致', checkLockVersion('3.2.2', { version: '3.2.2', packages: { '': { version: '3.2.1' } } }).some(r => r.level === 'FAIL'))
  check('锁文件根版本不一致会被发现', checkLockVersion('3.2.2', { version: '3.2.0', packages: { '': { version: '3.2.2' } } }).some(r => r.level === 'FAIL'))
  check('锁文件版本都正确才通过', checkLockVersion('3.2.2', { version: '3.2.2', packages: { '': { version: '3.2.2' } } }).every(r => r.level === 'OK'))
  console.log(`releaseArtifacts: ${passed} passed`)
} finally {
  const target = fs.realpathSync(root)
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('yfe-release-check-')) throw new Error('拒绝清理测试目录之外的路径')
  fs.rmSync(target, { recursive: true, force: true })
}
