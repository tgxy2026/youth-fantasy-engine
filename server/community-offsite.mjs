#!/usr/bin/env node
// Manual/offline preparation only. No scheduler or remote endpoint is enabled.
import { readFileSync } from 'node:fs'
import { encryptBackup, decryptBackup, sendBackupAlert } from './lib/communityOffsite.mjs'

const [operation, ...args] = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--output', '--key-file', '--url-file', '--token-file', '--event'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    console.error('参数错误')
    process.exit(2)
  }
  options[args[i]] = args[i + 1]
}
const events = { 'backup-failed': '社区备份失败，请检查备份日志。', 'backup-stale': '社区备份已过期，请检查备份任务。', 'disk-warning': '社区服务磁盘空间不足，请检查服务器。' }
const valid = ['encrypt', 'decrypt'].includes(operation)
  ? options['--input'] && options['--output'] && options['--key-file']
  : operation === 'alert' && options['--url-file'] && Object.hasOwn(events, options['--event'] || '')
if (!valid) {
  console.error('用法：encrypt|decrypt --input 路径 --output 路径 --key-file 密钥文件；或 alert --url-file 地址文件 --event backup-failed|backup-stale|disk-warning [--token-file 文件]')
  process.exit(2)
}
try {
  const result = operation === 'encrypt'
    ? encryptBackup({ backupDir: options['--input'], outputFile: options['--output'], keyFile: options['--key-file'] })
    : operation === 'decrypt'
      ? decryptBackup({ inputFile: options['--input'], outputDir: options['--output'], keyFile: options['--key-file'] })
      : await sendBackupAlert({ url: readFileSync(options['--url-file'], 'utf8').trim(), token: options['--token-file'] ? readFileSync(options['--token-file'], 'utf8').trim() : '', message: events[options['--event']] })
  console.log(JSON.stringify(result))
} catch (error) {
  // Do not print secret material, request body or provider response.
  console.error(error instanceof Error ? error.message : '操作失败')
  process.exitCode = 1
}
