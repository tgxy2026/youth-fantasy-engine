// 3.2.1 · T-11 复检结论备忘 · 单测
//
// 盯四件事（这四条错了，界面就会撒谎）：
//   ① 同章只留**最新**一条（重复复检不能堆成一串）；
//   ② 超上限淘汰**最旧**的，且不误伤其它章；
//   ③ 存储容错：老数据 / 手改坏的 JSON / 未来版本 ⇒ 空表，**绝不抛**（旁路数据不能拖垮面板）；
//   ④ 三态措辞分开：「原问题已清」/「N 条没解决」/「复检没跑成」—— 没有记录时界面不显示，
//      不能把"未运行"写成"已清"。
import './mock-memory'
import {
  upsertMemo, parseStore, isMemo, memoText, memoWhen, MAX_MEMOS, type RecheckMemo,
} from '@/lib/revision/recheckMemo'

let pass = 0, fail = 0
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

const mk = (over: Partial<RecheckMemo> = {}): RecheckMemo => ({
  chapterId: 'c1', at: 1000, state: 'done', ...over,
})

function main() {
  // ---------- ① 同章替换 ----------
  {
    const a = upsertMemo([], mk({ chapterId: 'c1', at: 100, resolved: 1 }))
    ok('① 空表插入一条', a.length === 1 && a[0].resolved === 1)
    const b = upsertMemo(a, mk({ chapterId: 'c1', at: 200, resolved: 3 }))
    ok('① 同章重复复检只留最新一条', b.length === 1 && b[0].at === 200 && b[0].resolved === 3, JSON.stringify(b))
    const c = upsertMemo(b, mk({ chapterId: 'c2', at: 150 }))
    ok('① 其它章不受影响', c.length === 2 && c.some(m => m.chapterId === 'c2'))
  }

  // ---------- ② 上限淘汰 ----------
  {
    let list: RecheckMemo[] = []
    for (let i = 0; i < 5; i++) list = upsertMemo(list, mk({ chapterId: 'c' + i, at: 1000 + i }), 3)
    ok('② 超上限只保留 max 条', list.length === 3, `len=${list.length}`)
    ok('② 淘汰的是最旧的（c0/c1 出局）', list.every(m => m.chapterId !== 'c0' && m.chapterId !== 'c1'), list.map(m => m.chapterId).join(','))
    ok('② 最新那条一定在', list.some(m => m.chapterId === 'c4'))
    ok('② max 传 0 / 负数时至少留 1 条（不把数据清空）',
      upsertMemo([], mk(), 0).length === 1 && upsertMemo([], mk(), -5).length === 1)
    ok('② MAX_MEMOS 是个合理正数', MAX_MEMOS > 0 && MAX_MEMOS <= 500, String(MAX_MEMOS))
  }

  // ---------- ③ 存储容错 ----------
  {
    ok('③ null ⇒ 空表', parseStore(null).length === 0)
    ok('③ 字符串 ⇒ 空表', parseStore('garbage').length === 0)
    ok('③ 版本不符 ⇒ 空表（不猜旧结构）', parseStore({ v: 99, items: [mk()] }).length === 0)
    ok('③ items 不是数组 ⇒ 空表', parseStore({ v: 1, items: 'x' as unknown }).length === 0)
    const mixed = parseStore({ v: 1, items: [mk(), { chapterId: '' }, { chapterId: 'x', at: 1, state: 'weird' }, null] })
    ok('③ 混入非法项时只留合法的那条', mixed.length === 1 && mixed[0].chapterId === 'c1', JSON.stringify(mixed))
    ok('③ isMemo 拒绝缺章号 / 缺时间 / 非法 state',
      !isMemo({ at: 1, state: 'done' }) && !isMemo({ chapterId: 'x', state: 'done' }) && !isMemo({ chapterId: 'x', at: 1, state: 'ok' }))
    ok('③ isMemo 接受 done / failed 两态', isMemo(mk()) && isMemo(mk({ state: 'failed' })))
  }

  // ---------- ④ 三态措辞 ----------
  {
    ok('④ done 且零问题 ⇒ 原问题已清', memoText(mk({ findings: 0 })) === '原问题已清', memoText(mk({ findings: 0 })))
    ok('④ done 但还剩别的问题 ⇒ 带上剩余数', memoText(mk({ findings: 3 })) === '原问题已清，还剩 3 个')
    ok('④ done 且有未解决项 ⇒ N 条没解决（不是"已清"）',
      memoText(mk({ stillOpen: ['错别字：在 → 再', '敏感词：毒'], findings: 2 })) === '2 条没解决')
    ok('④ failed ⇒ 复检没跑成，且带原因', memoText(mk({ state: 'failed', error: '模型超时' })) === '复检没跑成（模型超时）')
    ok('④ failed 无原因也不空着', memoText(mk({ state: 'failed' })) === '复检没跑成')
  }

  // ---------- ⑤ 时间人话 ----------
  {
    const now = new Date(2026, 9, 22, 12, 0, 0).getTime()
    ok('⑤ 今天', memoWhen(mk({ at: new Date(2026, 9, 22, 8, 12).getTime() }), now) === '今天 08:12')
    ok('⑤ 昨天', memoWhen(mk({ at: new Date(2026, 9, 21, 21, 40).getTime() }), now) === '昨天 21:40')
    ok('⑤ 更早带月日', memoWhen(mk({ at: new Date(2026, 9, 20, 19, 2).getTime() }), now) === '10-20 19:02')
  }

  console.log(`\n———— recheckMemo：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
