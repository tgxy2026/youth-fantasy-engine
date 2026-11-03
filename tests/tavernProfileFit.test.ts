// ============ 酒馆模式 · 「我的档案」↔ 阵容匹配自检（W3-4 / 方案 §13 F4）============
//
// 这是**非阻断提醒**的唯一判定入口（界面不许自己拼那个字符串）。
// 断言锁的是「什么时候该提醒、什么时候不该」—— 提醒太滥会被作者无视，
// 漏报则回到 §13 那个「关系有距离感」的老问题。所以两个方向都要钉。
import { checkProfileFit } from '../src/lib/tavern/profileFit'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ---------- 1) 空档案 → 不提醒（空档案整段不注入，谈不上「距离感」） ----------
  ok('空档案不提醒',
    checkProfileFit({ name: '', address: '', persona: '', castNames: ['洛汐'], userActsRole: false }) === null)
  ok('只有空格的档案视同空',
    checkProfileFit({ name: '  ', address: ' ', persona: '   ', castNames: ['洛汐'], userActsRole: true }) === null)

  // ---------- 2) persona 命中「旁观 / 只推进」类 → bystander ----------
  {
    const w = checkProfileFit({
      name: '张三', address: '', persona: '我不在场，只负责推进剧情。',
      castNames: ['洛汐'], userActsRole: false,
    })
    ok('旁白/推进定位 → 提醒', !!w && w.kind === 'bystander', JSON.stringify(w))
    ok('旁白提醒带原文摘要', !!w && w.text.includes('只负责推进'))
  }
  {
    const w = checkProfileFit({
      name: '张三', address: '', persona: '摄像机的视角，不参与对话。',
      castNames: [], userActsRole: false,
    })
    ok('「摄像机」也识别为旁观定位', !!w && w.kind === 'bystander', JSON.stringify(w))
  }

  // ---------- 3) 用户演了角色、但档案名跟这个角色对不上 → unknown-name ----------
  {
    const w = checkProfileFit({
      name: '老巴迪', address: '巴迪哥', persona: '三十出头的编剧。',
      castNames: ['洛汐', '楚楠'], userActsRole: true,
    })
    ok('档案名不在本场角色 → 提醒', !!w && w.kind === 'unknown-name', JSON.stringify(w))
    ok('unknown-name 优先用「称呼」而不是名字', !!w && w.text.includes('巴迪哥'))
  }

  // ---------- 4) 两条都命中 → both ----------
  {
    const w = checkProfileFit({
      name: '老巴迪', address: '', persona: '旁白，不在场。',
      castNames: ['洛汐'], userActsRole: true,
    })
    ok('旁观 + 名字对不上 → both', !!w && w.kind === 'both', JSON.stringify(w))
  }

  // ---------- 5) 一切正常 → 不提醒 ----------
  ok('演了角色且档案名就是该角色 → 不提醒',
    checkProfileFit({ name: '洛汐', address: '', persona: '怕生，话少。', castNames: ['洛汐', '楚楠'], userActsRole: true }) === null)
  ok('🔴 演自己时不比对角色名（否则必然误报）→ 不提醒',
    checkProfileFit({ name: '张三', address: '', persona: '普通玩家。', castNames: ['洛汐'], userActsRole: false }) === null)
  ok('本场没有角色卡 → 无从对照，不提醒',
    checkProfileFit({ name: '张三', address: '', persona: '普通玩家。', castNames: [], userActsRole: true }) === null)

  // ---------- 6) 边界：名字比对忽略大小写与首尾空格 ----------
  ok('名字比对忽略大小写/空格',
    checkProfileFit({ name: '  Loxi  ', address: '', persona: '怕生。', castNames: ['loxi'], userActsRole: true }) === null)

  console.log(`\ntavernProfileFit: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
