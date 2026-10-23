'use strict'
const fs = require('node:fs')
const path = require('node:path')

exports.checkLockVersion = (version, lock) => [
  ['package-lock.json', lock?.version],
  ['package-lock.json packages[""]', lock?.packages?.['']?.version],
].map(([item, actual]) => ({ level: actual === version ? 'OK' : 'FAIL', item: `版本 · ${item}`, detail: `${actual ?? '缺失'} vs package.json ${version}` }))

/** 只检查本版三件产物。旧版可以留存，但不充当本版包，也不要求先删旧包。 */
exports.checkArtifacts = (root, version, options = {}) => {
  const expected = [
    `青春幻想引擎-便携版-${version}-Windows.zip`,
    `青春幻想引擎-便携版-${version}-macOS-Linux.zip`,
    `桌面安装版/青春幻想引擎-Setup-${version}.exe`,
  ]
  const rows = []
  let ready = true
  for (const name of expected) {
    const file = path.join(root, name)
    let stat
    try { stat = fs.statSync(file) } catch { /* 缺包须在正式产物检查中明确失败 */ }
    if (!stat?.isFile() || stat.size === 0) {
      ready = false
      rows.push({ level: options.sourceOnly ? 'INFO' : 'FAIL', item: `本版产物 · ${name}`, detail: '缺失、为空或不是文件；尚不能作为本版交付物' })
      continue
    }
    const exe = name.endsWith('.exe')
    const limit = exe ? (options.setupBytes ?? 100 * 1024 * 1024) : (options.zipBytes ?? 50 * 1024 * 1024)
    const level = stat.size > limit ? (exe ? 'FAIL' : 'WARN') : 'OK'
    if (level === 'FAIL') ready = false
    rows.push({ level: options.sourceOnly ? 'INFO' : level, item: `本版产物 · ${name}`, detail: `${stat.size} B；${options.sourceOnly ? '源码阶段不验收产物' : `阈值 ${limit} B${exe ? '（硬上限）' : '（提醒线）'}`}` })
  }
  return { expected, rows, ready: !options.sourceOnly && ready }
}
