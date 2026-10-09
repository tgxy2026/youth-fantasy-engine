// ============ 酒馆模式 · 预设方案（A4）============
//
// 这一层最容易出的错是「存了但读不回」与「导入把别的 JSON 当设置吃进来」，
// 所以除 CRUD 外，重点断言**解析的形状校验**与**导出→导入的往返**。
import { __resetMockStores } from './mock-memory'
import * as presets from '../src/lib/tavern/presets'
import { getTavernSettings, saveTavernSettings, DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 1) 基本 CRUD ----------
  {
    __resetMockStores()
    ok('初始为空', (await presets.listPresets()).length === 0)

    const s = await getTavernSettings()
    const list1 = await presets.savePreset({ name: '  快速脑暴  ', data: s })
    ok('存一个：列表 +1', list1.length === 1)
    ok('名字会 trim', list1[0].name === '快速脑暴', list1[0].name)
    ok('带上创建与更新时间', list1[0].createdAt > 0 && list1[0].updatedAt >= list1[0].createdAt)

    const reloaded = await presets.listPresets()
    ok('落库后能读回（真正写的是 db meta，不是内存数组）', reloaded.length === 1 && reloaded[0].name === '快速脑暴')
    ok('快照里带着完整设置（含协议文本）',
      typeof reloaded[0].data.protocol === 'string' && reloaded[0].data.protocol.length > 500)

    const list2 = await presets.savePreset({ name: '精修成稿', data: s })
    ok('再存一个：列表 +2', list2.length === 2)

    // 覆盖：同 id 改名 + 换数据，createdAt 必须保留（它是"这份预设什么时候建的"）
    const first = list2[0]
    const list3 = await presets.savePreset({ id: first.id, name: '快速脑暴（改）', data: s })
    ok('同 id 覆盖而不是新增', list3.length === 2)
    const hit = list3.find(p => p.id === first.id)!
    ok('覆盖后名字变了', hit.name === '快速脑暴（改）', hit.name)
    ok('覆盖保留 createdAt（它记的是"这份预设何时建的"）', hit.createdAt === first.createdAt)
    ok('覆盖会刷新 updatedAt', hit.updatedAt >= first.updatedAt)

    const list4 = await presets.deletePreset(first.id)
    ok('删除：列表回到 1 条', list4.length === 1)
    ok('删掉的是那一条', !list4.some(p => p.id === first.id))
  }

  // ---------- 2) 导出 / 导入往返 ----------
  {
    __resetMockStores()
    const s = await getTavernSettings()
    // 改一个可辨认的值，验证「导入真的把值带回来了」
    const tweaked = { ...s, plot: { ...s.plot, temperature: 1.3 } }
    const [p] = await presets.savePreset({ name: '高温试演', data: tweaked })

    const text = presets.presetFileText(p)
    const raw = JSON.parse(text)
    ok('导出文本带 kind（用于识别是不是我们的文件）', raw.kind === 'youth-fantasy-engine.tavern-preset', String(raw.kind))
    ok('导出文本带 version', raw.version === 1)
    ok('导出文本带名字', raw.name === '高温试演')
    ok('导出文本带完整设置', !!raw.data && typeof raw.data.protocol === 'string')

    const back = presets.parsePresetFile(text)
    ok('往返：能解析回来', !!back.preset && !back.error, back.error ?? '')
    ok('往返：名字保留', back.preset?.name === '高温试演')
    ok('往返：改过的值也在', back.preset?.data.plot.temperature === 1.3)

    // 导入进来的必须落到库里才算「应用」，这里只验解析产物形状
    const merged = await saveTavernSettings(back.preset!.data)
    ok('把导入的数据交给 saveTavernSettings 后仍然是完整的', merged.plot.temperature === 1.3 && typeof merged.protocol === 'string')
  }

  // ---------- 3) 解析的容错（宁可拒绝，不能吃错） ----------
  {
    ok('非 JSON：明确报错', !!presets.parsePresetFile('这不是 json {').error)
    ok('JSON 但不是对象：报错', !!presets.parsePresetFile('"字符串"').error)
    ok('对象但缺三段：报错', !!presets.parsePresetFile('{"a":1}').error)
    ok('缺 free 段：报错', !!presets.parsePresetFile(JSON.stringify({ common: {}, plot: {}, profile: {} })).error)
    ok('三段齐全：通过', !!presets.parsePresetFile(JSON.stringify({ common: {}, plot: {}, free: {} })).preset)

    // 裸设置对象（没包 data）也要能吃 —— 有人会直接导出一份设置 JSON
    const bare = presets.parsePresetFile(JSON.stringify({
      common: DEFAULT_TAVERN_SETTINGS.common,
      plot: DEFAULT_TAVERN_SETTINGS.plot,
      free: DEFAULT_TAVERN_SETTINGS.free,
    }))
    ok('裸设置对象（未包 data）也能导入', !!bare.preset, bare.error ?? '')
    ok('没名字时给个兜底名（不留空标题）', (bare.preset?.name ?? '') === '导入的预设', bare.preset?.name ?? '')

    // 名字字段是空的 → 兜底；是数字 → 转字符串，别把非字符串塞进类型
    const named = presets.parsePresetFile(JSON.stringify({ name: '  ', common: {}, plot: {}, free: {} }))
    ok('名字为空白时兜底', named.preset?.name === '导入的预设')
  }

  // ---------- 4) 文件名 ----------
  {
    const fn = presets.presetFileName('快速/脑暴 试演:版')
    ok('文件名洗掉路径与非法字符', !/[\\/:*?"<>|\s]/.test(fn), fn)
    ok('文件名带日期与后缀', /_\d{8}\.tavernpreset\.json$/.test(fn), fn)
    const empty = presets.presetFileName('///')
    ok('名字全是非法字符时仍有可用文件名', empty.startsWith('预设_'), empty)
  }

  console.log(`\ntavernPresets: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
