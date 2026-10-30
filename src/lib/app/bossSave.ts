// ============ 3.3.2 · 老板键的保存编排 ============
//
// 【它补的是哪一段】快捷键按下后「立即隐藏 + 同时开始保存」（规划 §15.3）。隐藏那一步在主进程，
//   保存这一步在渲染层 —— 而"隐藏是否成功"与"保存是否成功"是两件事，必须分别记账。
//
// 🔴 **不能只调 `flushDesktop()`**：它写的是 store 里的内存快照，而正文草稿还有 2 秒防抖，
//    草稿没进 store 时 flush 成功也代表"刚写的那句没保存"。
//    所以先走**离页屏障**（`runLeaveGuard`，会如实返回失败，不吞异常），再落盘。
//
// 🔴 网页云端只能承诺"服务端回执"；网页游客只在自己浏览器里，不能宣称云端已保存。
//    文案按形态分开写，不要用一句"已保存"糊过去。
import { DESKTOP, flushDesktop } from '@/lib/app/desktop'
import { PORTABLE, flushPortable } from '@/lib/storage/fileBackend'
import { WEB, WEB_CLOUD } from '@/lib/app/platform'
import { runLeaveGuard, type LeaveScope } from '@/lib/editor/leaveBarrier'

export interface BossSaveResult {
  ok: boolean
  /** 可直接显示的实话 */
  message: string
  scope: 'local' | 'cloud' | 'none'
}

const SCOPE_TEXT: Record<LeaveScope, string> = {
  content: '正文草稿',
  meta: '标题与摘要',
  record: '设定或表格里的编辑',
}

/**
 * 跑一次保存屏障。
 * @returns 成功/失败 + 一句能直接给作者看的话（失败时**不要说"已保存"**）
 *
 * 🔴 不只在老板键里用：任何"要以本机当前内容为准"的操作（立即同步 / 另存为新书 /
 *    用云端覆盖）都必须先过这一关 —— `exportProject()` 读的是 store，
 *    正文草稿还在 2 秒防抖里时，上传出去的"本机版本"会少最后几句。
 */
export async function runSaveBarrier(): Promise<BossSaveResult> {
  // ① 组件内的未落库草稿（与换页签时同一套判据）
  const guard = await runLeaveGuard()
  if (!guard.ok) {
    const where = SCOPE_TEXT[guard.scope] || '编辑内容'
    return {
      ok: false,
      scope: 'local',
      message: `${where}还没保存好，恢复窗口后请重试保存（内容仍在页面上，没有丢）`,
    }
  }

  // ② 落盘 / 提交
  if (DESKTOP) {
    const ok = await flushDesktop().catch(() => false)
    return ok
      ? { ok: true, scope: 'local', message: '已保存到本机' }
      : { ok: false, scope: 'local', message: '本机写盘失败（磁盘满或被其他程序占用），恢复窗口后请重试' }
  }

  if (WEB && WEB_CLOUD) {
    const ok = await flushPortable().catch(() => false)
    return ok
      ? { ok: true, scope: 'cloud', message: '已写入云端' }
      : { ok: false, scope: 'cloud', message: '云端保存没有确认（网络或登录状态），恢复窗口后请重试' }
  }

  if (WEB) {
    // 游客：数据在浏览器 IndexedDB，写入是即时的；没有"服务端回执"这回事
    return { ok: true, scope: 'local', message: '已写入本机浏览器存储' }
  }

  if (PORTABLE) {
    const ok = await flushPortable().catch(() => false)
    return ok
      ? { ok: true, scope: 'local', message: '已保存到本机数据目录' }
      : { ok: false, scope: 'local', message: '写盘失败（U 盘拔出 / 只读 / 空间不足），恢复窗口后请重试' }
  }

  return { ok: true, scope: 'none', message: '' }
}

/** 老板键侧的旧名字（保留既有调用点）；新代码请用 `runSaveBarrier` */
export const runBossSaveBarrier = runSaveBarrier