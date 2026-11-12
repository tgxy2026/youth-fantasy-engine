// Optional encrypted copy of an already verified, stopped-service backup.
// The destination is a caller-provided mounted directory; this module does not
// configure a remote provider, scheduler, key store or alert recipient.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { COMMUNITY_FILES, BACKUP_MANIFEST, verifyBackup } from './communityBackup.mjs'

const files = [...COMMUNITY_FILES, BACKUP_MANIFEST]
const magic = Buffer.from('YFE-COMMUNITY-1\0')
const maxArchiveBytes = 256 * 1024 * 1024

function readKey(keyFile) {
  const key = readFileSync(keyFile)
  if (key.length !== 32) throw new Error('加密密钥文件必须恰好为 32 字节')
  return key
}

// Never overwrite a previously delivered copy. Temporary file is created in
// the target filesystem and published via an exclusive hard link.
export function encryptBackup({ backupDir, outputFile, keyFile }) {
  const checked = verifyBackup(backupDir)
  if (!checked.ok) throw new Error('备份校验失败，拒绝生成异地副本')
  const content = Object.fromEntries(files.map((name) => [name, readFileSync(join(backupDir, name)).toString('base64')]))
  const manifest = JSON.parse(Buffer.from(content[BACKUP_MANIFEST], 'base64').toString('utf8'))
  for (const name of COMMUNITY_FILES) {
    const bytes = Buffer.from(content[name], 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]?.sha256) throw new Error('备份在读取期间发生变化')
  }
  const plain = Buffer.from(JSON.stringify({ version: 1, files: content }))
  if (plain.length > maxArchiveBytes) throw new Error('备份超出加密工具的大小限制')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', readKey(keyFile), iv)
  cipher.setAAD(magic)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const encoded = Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext])
  const temporary = join(dirname(outputFile), `.${basename(outputFile)}.${randomBytes(12).toString('hex')}.tmp`)
  let created = false
  try {
    writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 })
    created = true
    linkSync(temporary, outputFile)
  } finally {
    if (created) unlinkSync(temporary)
  }
  return { ok: true, bytes: encoded.length }
}

// Decrypt only to a new directory. Authenticated data is checked before any
// files are written; the regular backup verifier must also accept the result.
export function decryptBackup({ inputFile, outputDir, keyFile }) {
  const encoded = readFileSync(inputFile)
  if (encoded.length > maxArchiveBytes + 128 || encoded.length < magic.length + 28 || !encoded.subarray(0, magic.length).equals(magic)) throw new Error('加密副本格式或大小不正确')
  const iv = encoded.subarray(magic.length, magic.length + 12)
  const tag = encoded.subarray(magic.length + 12, magic.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', readKey(keyFile), iv)
  decipher.setAAD(magic)
  decipher.setAuthTag(tag)
  const archive = JSON.parse(Buffer.concat([decipher.update(encoded.subarray(magic.length + 28)), decipher.final()]).toString('utf8'))
  if (archive.version !== 1 || !archive.files || Object.keys(archive.files).length !== files.length || files.some((name) => typeof archive.files[name] !== 'string')) throw new Error('加密副本内容不完整')
  mkdirSync(outputDir, { mode: 0o700 })
  for (const name of files) writeFileSync(join(outputDir, name), Buffer.from(archive.files[name], 'base64'), { flag: 'wx', mode: 0o600 })
  if (!verifyBackup(outputDir).ok) throw new Error('解密后的备份校验失败；保留隔离目录供核查')
  return { ok: true }
}

// No automatic configuration or automatic notification. HTTPS is required;
// loopback HTTP is accepted solely for an isolated integration test.
export async function sendBackupAlert({ url, message, token = '', allowLoopbackHttp = false }) {
  const target = new URL(url)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  if (target.username || target.password || (target.protocol !== 'https:' && !(allowLoopbackHttp && loopback && target.protocol === 'http:'))) throw new Error('告警地址必须使用 HTTPS')
  if (!message || message.length > 500) throw new Error('告警内容长度不合法')
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ text: message }), redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`告警接收端返回 HTTP ${response.status}`)
  return { ok: true }
}
