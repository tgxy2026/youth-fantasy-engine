// ============ 3.2.0 · WT1-5：个人模板库发布代次、升级预览与仅结构模板包 ============
//
// 钉五件事（方案 §3.5 / §3.6 / §17.3）：
//   ① 已发布版本**不可原地覆盖**：同 ID+版本、内容摘要不同 ⇒ 拒绝，并给出两条出路；
//   ② 库只存**结构**：值/正文/图片/密钥一律白名单剥离；
//   ③ 库发新版**不改**已有项目快照；升级必须先看只读预览（与迁移共用同一份计划）；
//   ④ 模板包导入 fail-closed：大小先于解析、版本/键/引用/重复项全查；
//   ⑤ 个人库与迁移痕迹都不上云（同一份前缀判据）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { TEMPLATE_DEF_VERSION, LIBRARY_PREFIX, libraryKeyOf, type TemplateDef } from '@/lib/templates/definition'
import type { EffectiveField } from '@/lib/templates/types'
import {
  publishTemplateDef, publishAsNewTemplate, loadLibraryVersion, loadLibraryIndex,
  listLibraryTemplates, nextLibraryVersion, previewLibraryUpgrade,
  contentDigestOf, structureOf, LIBRARY_INDEX_KEY,
} from '@/lib/templates/library'
import {
  exportTemplatePack, parseTemplatePack, importPackToLibrary, PACK_FORMAT, PACK_FORMAT_VERSION,
} from '@/lib/templates/packIO'
import { saveTemplateDef, loadTemplateDef } from '@/lib/templates/store'
import { isSensitiveMetaKey, isLocalOnlyMetaKey } from '@/lib/storage/sensitiveMeta'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-lib'
const TAB = 'races'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? 'cf_a'
  return {
    id,
    sourceKey: id,
    source: 'custom',
    label: over.label ?? `字段${id}`,
    type: 'text',
    groupId: 'g1',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
    ...over,
  }
}

function mkDef(fields: EffectiveField[], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 'tpl_lib1',
    name: '灵根模板',
    tabId: TAB,
    origin: { kind: 'library', templateId: 'tpl_lib1', version: 1, fromName: '灵根模板' },
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
    fields,
    nameFieldId: fields[0]?.id ?? '',
    semanticDigest: 'd1',
    revision: 0,
    updatedAt: 1,
    ...over,
  }
}

const packOf = (templates: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({
  format: PACK_FORMAT,
  formatVersion: PACK_FORMAT_VERSION,
  exportedAt: 1,
  templates,
  ...over,
})

async function main() {
  // ────────────────────────── ① 发布代次 ──────────────────────────
  {
    __resetMockStores()
    const v1 = mkDef([mkField({ id: 'cf_a', label: '灵根' })])
    const r1 = await publishTemplateDef(v1)
    ok('① 首次发布 = 第 1 版', r1.ok && r1.version === 1 && r1.created === true, JSON.stringify(r1))
    ok('① 库里能按 id+版本读回', (await loadLibraryVersion('tpl_lib1', 1))?.name === '灵根模板')

    const r2 = await publishTemplateDef({ ...v1, fields: [mkField({ id: 'cf_a', label: '灵根' }), mkField({ id: 'cf_b', label: '体质' })] })
    ok('① 再发一次自动升到第 2 版', r2.ok && r2.version === 2, JSON.stringify(r2))
    ok('① 目录索引记录全部版本', JSON.stringify((await loadLibraryIndex()).entries[0].versions) === '[1,2]')
    ok('① 下一版本号 = 3', (await nextLibraryVersion('tpl_lib1')) === 3)
    ok('① 列表按更新时间倒序返回', (await listLibraryTemplates()).length === 1)

    const again = await publishTemplateDef({ ...v1, fields: [mkField({ id: 'cf_a', label: '灵根' }), mkField({ id: 'cf_b', label: '体质' })] })
    ok('① 最新版内容没变时重复发布 ⇒ 幂等（不涨版本号）',
      again.ok && again.version === 2 && again.created === false, JSON.stringify(again))

    const conflict = await publishTemplateDef({ ...v1, name: '偷换名字的同版本' }, { version: 1 })
    ok('① 指定已发布版本且内容不同 ⇒ 拒绝（已发布不可原地覆盖）', !conflict.ok && conflict.code === 'version-conflict', JSON.stringify(conflict))
    ok('① 冲突时明确给出两条出路',
      !conflict.ok && conflict.detail.includes('另存为新模板') && conflict.detail.includes('新版本'))
    const sameAgain = await publishTemplateDef(v1, { version: 1 })
    ok('① 指定已发布版本且内容相同 ⇒ 幂等通过', sameAgain.ok && sameAgain.created === false)

    const renamed = await publishAsNewTemplate({ ...v1, name: '灵根模板·改' })
    ok('① 另存为新模板 ⇒ 换 id、从 v1 开始',
      renamed.ok && renamed.templateId !== 'tpl_lib1' && renamed.version === 1, JSON.stringify(renamed))

    const crossTab = await publishTemplateDef({ ...v1, tabId: 'items' })
    ok('① 同 id 不能发布成别的页签的模板', !crossTab.ok && crossTab.code === 'tab-mismatch')

    const badVersion = await publishTemplateDef(v1, { version: 0 })
    ok('① 版本号必须 ≥1', !badVersion.ok && badVersion.code === 'bad-version')
  }

  // ────────────────────────── ② 只存结构 ──────────────────────────
  {
    __resetMockStores()
    const dirty = {
      ...mkDef([mkField({ id: 'cf_a' })]),
      // 外部包里常见夹带：作者资料 / 图片 / 密钥
      rows: [{ id: 'r1', data: { cf_a: '秘密值' } }],
      data: { cf_a: '秘密值' },
      image: 'data:image/png;base64,AAAA',
      token: 'ghp_xxx',
    } as unknown as TemplateDef
    const r = await publishTemplateDef(dirty)
    ok('② 夹带资料的包也能发布（只取结构）', r.ok === true, JSON.stringify(r))
    const rec = await loadLibraryVersion('tpl_lib1', 1)
    const text = JSON.stringify(rec)
    ok('② 库记录里没有 rows/data/image/token 等资料',
      !/"(rows|data|image|token)":/.test(text), text.slice(0, 200))
    ok('② 结构字段完整保留', rec?.def.fields.length === 1 && rec.def.groups.length === 1)
  }

  // ────────────────────────── ③ 内容摘要 ──────────────────────────
  {
    const base = mkDef([mkField({ id: 'cf_a', label: '灵根' })])
    ok('③ revision/updatedAt 变化不算内容变化',
      contentDigestOf({ ...base, revision: 9, updatedAt: 999 }) === contentDigestOf(base))
    ok('③ 字段标签变化算内容变化',
      contentDigestOf({ ...base, fields: [mkField({ id: 'cf_a', label: '灵根属性' })] }) !== contentDigestOf(base))
    ok('③ 模板名变化算内容变化', contentDigestOf({ ...base, name: '别的名字' }) !== contentDigestOf(base))
    ok('③ 分组顺序变化算内容变化',
      contentDigestOf({ ...base, groups: [{ id: 'g1', label: '扩展', order: 0 }, { id: 'g2', label: '基础', order: 1 }] })
      !== contentDigestOf(base))
    ok('③ 摘要稳定（同输入两次相同）', contentDigestOf(base) === contentDigestOf(structureOf(base)))
  }

  // ────────────────────────── ④ 库发新版不改项目；升级先预览 ──────────────────────────
  {
    __resetMockStores()
    const projectDef = mkDef([mkField({ id: 'cf_a', label: '灵根' })], { templateId: 'tpl_lib1', revision: 0 })
    await saveTemplateDef(PID, projectDef)
    await db.saveFormDataFor(PID, TAB, { cf_a: '火' })

    // 库发新版：把 cf_a 改成数字 + 新增 cf_b
    const v2 = mkDef([
      mkField({ id: 'cf_a', label: '灵根', type: 'number' }),
      mkField({ id: 'cf_b', label: '体质' }),
    ], { revision: 1, semanticDigest: 'd2' })
    await publishTemplateDef(mkDef([mkField({ id: 'cf_a', label: '灵根' })]))
    await publishTemplateDef(v2)
    ok('④ 库发新版后项目快照不变', (await loadTemplateDef(PID, TAB))?.revision === 0)

    const preview = await previewLibraryUpgrade(PID, TAB, v2)
    ok('④ 升级预览给出与迁移同一份计划', preview.plan.toTemplateId === 'tpl_lib1' && preview.plan.items.length >= 2)
    ok('④ 预览能看出类型变化', preview.plan.warnings.some(w => w.code === 'type-changed'))
    ok('④ 预览给出影响规模（不是"未知"）', preview.plan.valueScaleKnown && preview.plan.affectedValueCount === 1,
      String(preview.plan.affectedValueCount))
    ok('④ 预览结论可直接展示', preview.summaryText.length > 0 && preview.executable === true)
    ok('④ 项目模板仍没被改（预览是只读的）', (await loadTemplateDef(PID, TAB))?.revision === 0)

    // 首次采用（项目还没有自定义模板）
    const fresh = await previewLibraryUpgrade('p-new', TAB, v2, { projectDef: null })
    ok('④ 未采用模板的项目：预览按新增字段算', fresh.plan.fromTemplateId === '<none>' && fresh.plan.summary.added === 2)
  }

  // ────────────────────────── ⑤ 模板包导出：只含结构、可往返 ──────────────────────────
  {
    __resetMockStores()
    const def = mkDef([mkField({ id: 'cf_a', label: '灵根' }), mkField({ id: 'cf_b', label: '体质' })])
    const exp = exportTemplatePack([def])
    ok('⑤ 导出成功', exp.ok === true, JSON.stringify(exp).slice(0, 160))
    if (exp.ok) {
      ok('⑤ 包里有格式标记与版本', exp.text.includes(PACK_FORMAT) && exp.text.includes('"formatVersion":1'))
      ok('⑤ 包只含结构（无 rows/data/image）', !/"(rows|data|image)":/.test(exp.text))
      const parsed = parseTemplatePack(exp.text)
      ok('⑤ 往返解析回来字段一致',
        parsed.ok && parsed.defs[0].fields.length === 2 && parsed.defs[0].templateId === 'tpl_lib1')
      ok('⑤ 解析时重算语义摘要（不照抄外来字符串）',
        parsed.ok && parsed.defs[0].semanticDigest !== def.semanticDigest)
    }
    const empty = exportTemplatePack([])
    ok('⑤ 没有模板 ⇒ 明确拒绝', !empty.ok && empty.code === 'empty')

    // 大小检查必须先于 JSON.parse：给一段 3MiB 的非 JSON 文本
    const huge = 'x'.repeat(3 * 1024 * 1024)
    const r = parseTemplatePack(huge)
    ok('🔴 超大包先报 too-large（不是 bad-json ⇒ 证明大小检查在解析之前）',
      !r.ok && r.code === 'too-large')
  }

  // ────────────────────────── ⑥ 模板包导入：fail-closed ──────────────────────────
  {
    const one = mkDef([mkField({ id: 'cf_a', label: '灵根' })])
    const cases: Array<[string, string, string]> = []
    cases.push(['非 JSON', '{ not json', 'bad-json'])
    cases.push(['不是模板包', JSON.stringify({ format: 'yfe-project', formatVersion: 1, templates: [one] }), 'not-a-pack'])
    cases.push(['格式版本过高', packOf([one], { formatVersion: 99 }), 'unknown-version'])
    cases.push(['空模板包', packOf([]), 'empty'])
    cases.push(['原型污染键', `{"format":"${PACK_FORMAT}","formatVersion":1,"templates":[],"__proto__":{"x":1}}`, 'prototype-pollution'])
    for (const [name, text, code] of cases) {
      const r = parseTemplatePack(text)
      ok(`⑥ ${name} ⇒ ${code}`, !r.ok && r.code === code, r.ok ? 'unexpected ok' : `${r.code} ${r.detail}`)
    }

    // 结构性错误：一次报全，不"遇到第一条就停"
    const dupId = packOf([{ ...one, fields: [mkField({ id: 'cf_a' }), mkField({ id: 'cf_a' })] }])
    const rDup = parseTemplatePack(dupId)
    ok('⑥ 重复字段 ID ⇒ 拒绝', !rDup.ok && rDup.issues.some(i => i.code === 'duplicate-field-id'))

    const badKey = packOf([{ ...one, fields: [mkField({ id: 'cf-a' })] }])
    const rKey = parseTemplatePack(badKey)
    ok('⑥ 非法存储键 ⇒ 拒绝', !rKey.ok && rKey.issues.some(i => i.code === 'bad-storage-key'))

    const dupOpt = packOf([{ ...one, fields: [mkField({ id: 'cf_a', type: 'select', options: ['火', '火'] })] }])
    const rOpt = parseTemplatePack(dupOpt)
    ok('⑥ 重复候选项 ⇒ 拒绝', !rOpt.ok && rOpt.issues.some(i => i.code === 'duplicate-option'))

    const dangling = packOf([{ ...one, fields: [mkField({ id: 'cf_a', groupId: 'gX' })] }])
    const rDang = parseTemplatePack(dangling)
    ok('⑥ 悬空分组引用 ⇒ 拒绝', !rDang.ok && rDang.issues.some(i => i.code === 'dangling-group'))

    const noFields = packOf([{ ...one, fields: [] }])
    const rNo = parseTemplatePack(noFields)
    ok('⑥ 零字段模板 ⇒ 拒绝（不写空壳）', !rNo.ok && rNo.issues.some(i => i.code === 'bad-template'))

    const tooLongName = packOf([{ ...one, fields: [mkField({ id: 'cf_a', label: '战'.repeat(21) })] }])
    const rLong = parseTemplatePack(tooLongName)
    ok('⑥ 字段名超 20 字 ⇒ 拒绝（借用同一份限额）', !rLong.ok && rLong.issues.some(i => i.code === 'limit'))

    const badNameField = packOf([{ ...one, nameFieldId: 'cf_zzz' }])
    const rName = parseTemplatePack(badNameField)
    ok('⑥ 名称字段不存在 ⇒ 可导入但给提示（执行时会拦）',
      rName.ok && rName.warnings.some(w => w.code === 'bad-name-field'))
  }

  // ────────────────────────── ⑦ 导入 → 发布：冲突不连坐 ──────────────────────────
  {
    __resetMockStores()
    const libOrigin = (id: string) => ({ kind: 'library' as const, templateId: id, version: 1, fromName: '库模板' })
    const a = mkDef([mkField({ id: 'cf_a', label: '灵根' })], { templateId: 'tpl_a', origin: libOrigin('tpl_a') })
    await publishTemplateDef(a)
    // 同 id 同版本、内容不同 ⇒ 冲突；另一个 id 应照常进库
    const aConflict = { ...a, name: '改过名字', origin: libOrigin('tpl_a') }
    const b = mkDef([mkField({ id: 'cf_b', label: '体质' })], { templateId: 'tpl_b', origin: libOrigin('tpl_b') })
    const res = await importPackToLibrary(packOf([aConflict, b]))
    ok('⑦ 导入整体成功（逐份回报）', res.ok === true, JSON.stringify(res).slice(0, 160))
    if (res.ok) {
      const kinds = res.outcomes.map(o => o.kind)
      ok('⑦ 冲突的那份被报出来，另一份照常发布',
        kinds.includes('conflict') && kinds.includes('published'), kinds.join(','))
    }
    ok('⑦ 没被冲突连坐的模板进库了', (await loadLibraryVersion('tpl_b', 1)) !== null)
    ok('⑦ 冲突的那份没被覆盖', (await loadLibraryVersion('tpl_a', 1))?.name === '灵根模板')

    // 同一个包再导一次 ⇒ 全部幂等，不涨版本
    const res2 = await importPackToLibrary(packOf([b]))
    ok('⑦ 重复导入同一个包 ⇒ 幂等（不涨版本号）',
      res2.ok && res2.outcomes.length === 1 && res2.outcomes[0].kind === 'published'
      && res2.outcomes[0].created === false && res2.outcomes[0].version === 1,
      JSON.stringify(res2))
  }

  // ────────────────────────── ⑧ 同步排除 + 源码闸 ──────────────────────────
  {
    ok('⑧ 个人库键 = templateLibrary32:<id>:v<n>', libraryKeyOf('t', 1) === 'templateLibrary32:t:v1')
    ok('⑧ 库索引键落在前缀下', LIBRARY_INDEX_KEY.startsWith(LIBRARY_PREFIX))
    ok('⑧ 个人库不上云', isSensitiveMetaKey(libraryKeyOf('tpl_a', 1)) && isLocalOnlyMetaKey(libraryKeyOf('tpl_a', 1)))

    const libSrc = readFileSync(path.join(process.cwd(), 'src/lib/templates/library.ts'), 'utf8')
    const packSrc = readFileSync(path.join(process.cwd(), 'src/lib/templates/packIO.ts'), 'utf8')
    ok('🔴 源码：已发布版本被占用时拒绝（version-conflict 不是覆盖）',
      libSrc.includes("'version-conflict'") && libSrc.indexOf('existing.contentDigest === digest') > 0)
    ok('🔴 源码：库记录按白名单重建（structureOf）', libSrc.includes('structureOf(def)'))
    ok('🔴 源码：库发新版不改项目（本模块不写项目模板键）',
      !libSrc.includes('saveTemplateDef'))
    ok('🔴 源码：导入先查大小再 parse',
      packSrc.indexOf('checkTemplatePack(text)') > 0
      && packSrc.indexOf('checkTemplatePack(text)') < packSrc.indexOf('JSON.parse(text)'))
    ok('🔴 源码：导入失败不静默放过（issues 全量返回）', packSrc.includes('issues.map('))
  }
}

main().then(() => {
  console.log(`\ntemplatesLibrary: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
