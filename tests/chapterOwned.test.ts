// ============ 章节归属（防「跨章串报告」）· 单测（2.6.3 六维审计 P1）============
//
// 钉住 `/lib/aiTaskCenter` 的章节归属判据 —— 这是 2.6.3 六维审计抓出的 P1：
//   `useTaskRunner` 按 (ownerTab, kind) 取**最近一条**任务（任务中心不支持按业务键取历史），
//   于是「A 章跑完 → 换到 B 章」时，B 章面板会把 A 章的报告当成本章的（串章）。
//   对策：发起时把章节戳盖进 progress/result，取值只放行「归属 == 当前章」的那份。
//
// ⚠️ 本文件**只测判据本身**（纯函数），不测 React 接线 —— 接线由各面板的调用点保证。
import {
  chapterOwned, taskChapter,
  type ChOwned, type ChProgress, type TaskRunner,
} from '../src/lib/ai/aiTaskCenter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一个「像 runner」的替身：只需 task / result / error / running 四个字段 */
function fake<T>(
  task: { status: string; progress?: unknown; result?: unknown; error?: string } | null,
  running = false,
): TaskRunner<ChOwned<T>, ChProgress> {
  return {
    task: task as never,
    result: (task?.result ?? null) as never,
    error: (task?.error ?? '') as never,
    running,
    run: () => {},
    stop: () => {},
    clear: () => {},
  }
}

function main() {
  // ---------- taskChapter：读进度里的章节戳 ----------
  {
    ok('taskChapter 读得到进度里的 ch',
      taskChapter({ progress: { ch: 'c9' } }) === 'c9')
    ok('taskChapter 对「无进度」返回空串', taskChapter({ progress: null }) === '')
    ok('taskChapter 对 null 任务返回空串', taskChapter(null) === '')
  }

  // ---------- 本章：正常放行 ----------
  {
    const done = fake<{ n: number }>({ status: 'done', progress: { ch: 'c1' }, result: { ch: 'c1', v: { n: 7 } } })
    const v = chapterOwned(done, 'c1')
    ok('本章 done → 返回数据', v.data?.n === 7, JSON.stringify(v))
    ok('本章 done → 不显示 loading', v.loading === false)
    ok('本章 done → 无 error', !v.error)

    const running = fake<{ n: number }>({ status: 'running', progress: { ch: 'c1' } }, true)
    ok('本章 running → loading 为真', chapterOwned(running, 'c1').loading === true)
    ok('本章 running → 暂无可看数据', chapterOwned(running, 'c1').data === undefined)

    const failed = fake<{ n: number }>({ status: 'failed', progress: { ch: 'c1' }, error: '模型超时' })
    ok('本章 failed → 透出错误原因', chapterOwned(failed, 'c1').error === '模型超时')
  }

  // ---------- 他章：一律当作「没跑过」 ----------
  {
    const doneOther = fake<{ n: number }>({ status: 'done', progress: { ch: 'c1' }, result: { ch: 'c1', v: { n: 7 } } })
    const v = chapterOwned(doneOther, 'c2')
    ok('🔴 他章 done → 不得串报告（data 为空）', v.data === undefined, JSON.stringify(v))
    ok('他章 done → 不显示 loading', v.loading === false)
    ok('他章 done → 不显示 error', !v.error)

    const runningOther = fake<{ n: number }>({ status: 'running', progress: { ch: 'c1' } }, true)
    ok('🔴 他章 running → 本章不显示 loading（进度也算串）', chapterOwned(runningOther, 'c2').loading === false)

    const failedOther = fake<{ n: number }>({ status: 'failed', progress: { ch: 'c1' }, error: '模型超时' })
    ok('🔴 他章 failed → 不得把别章的报错显示到本章', chapterOwned(failedOther, 'c2').error === undefined)
  }

  // ---------- 无章节戳（旧记录 / 未盖戳）：不得冒充本章 ----------
  {
    const unstamped = fake<{ n: number }>({ status: 'done', result: { ch: '', v: { n: 1 } } })
    ok('🔴 无章节戳的任务在具名章节下不成立', chapterOwned(unstamped, 'c1').data === undefined)
    ok('无章节戳 + 空章节键 → 视为同章（未进项目/无本章）',
      chapterOwned(unstamped, '').data?.n === 1)
  }

  // ---------- 中止：既不是数据也不是错误 ----------
  {
    const aborted = fake<{ n: number }>({ status: 'aborted', progress: { ch: 'c1' } })
    const v = chapterOwned(aborted, 'c1')
    ok('中止（本章）→ 无数据、无 error、不在 loading', !v.data && !v.error && !v.loading, JSON.stringify(v))
  }

  console.log(`\nchapterOwned: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
