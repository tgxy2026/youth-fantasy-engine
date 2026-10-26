/**
 * 详情页的**工作现场记忆**（UX06 · 分组展开 + 滚动位置）。
 *
 * 【它解决什么】
 *   作者在角色档案展开「势力关系」翻到一半，去别的页签看一眼再回来——
 *   分组又全收起、滚动回到顶上，得重新点一遍、翻一遍。这里把「哪些组展开着、滚到哪」记住。
 *
 * 【和正文那一套的区别】
 *   正文靠「离页/切章时同步抓一次」（`useEditorWorkspaceView`）；详情页的切换入口太多
 *   （列表点选 / 新增 / 删除 / 移动页签…），逐个插 capture 既脏又容易漏。
 *   所以改成**边改边记**：折叠一次就写一次，滚动停下再写一次（store 只在内存里，
 *   不落 localStorage，代价就是一次 Map 写入）。这样切换对象时不需要"临走抓一下"，
 *   也不会因为内容换掉把旧对象的滚动位置覆盖成 0。
 *
 * 【红线】
 *   · 只存分组 id 与滚动比例/像素，不存任何字段内容；单条 16KiB 上限由 store 保证。
 *   · 记录对象必须等于当前对象才恢复；换项目/换身份/store 失效一律不套用。
 *   · 恢复不抢焦点、不改 DOM 结构，只改 `open` 属性与 scrollTop。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import * as db from '@/lib/db'
import { currentWorkspaceScope, registerWorkspaceCapture } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type DetailView } from '@/lib/settings/workspaceViewState'
import { scrollRatio } from '@/lib/editor/editorViewMath'

/** 滚动停下多久算「停稳了」（只影响记录频率，不影响任何判定） */
const SETTLE_MS = 300
/** 恢复时等布局稳定的上限帧数（分组展开会改高度） */
const STABLE_FRAMES = 40

export interface DetailWorkspaceArgs {
  /** 页面命名空间：角色页与各设定页各用各的（记录不串） */
  pageId: string
  /** 当前对象 id（角色卡 id）；空表示还没选中 */
  objectId: string | null
  /** 默认展开的分组 id（基础组 / 首组）——没有记录时用它 */
  defaultGroups: string[]
  /** 详情滚动容器 */
  scrollRef: RefObject<HTMLDivElement>
}

const groupsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(item => b.has(item))

/** 等容器高度稳定两帧：分组展开/字体晚到都会改高度，别用固定 setTimeout 猜 */
async function settle(el: HTMLElement, cancelled: () => boolean): Promise<void> {
  let last = -1
  let stable = 0
  for (let frame = 0; frame < STABLE_FRAMES; frame += 1) {
    if (cancelled()) return
    if (el.clientHeight > 0 && el.clientHeight === last) {
      stable += 1
      if (stable >= 2) return
    } else stable = 0
    last = el.clientHeight
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
  }
}

export function useDetailWorkspaceView({ pageId, objectId, defaultGroups, scrollRef }: DetailWorkspaceArgs): {
  expanded: Set<string>
  toggle: (groupId: string, open: boolean) => void
} {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultGroups))
  const live = useRef({ objectId, expanded, defaults: defaultGroups })
  live.current = { objectId, expanded, defaults: defaultGroups }
  const restoreToken = useRef(0)
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const write = useCallback((id: string | null, groups: Set<string>, el: HTMLElement | null) => {
    if (!id || !el) return
    const projectId = db.getCurrentProjectId()
    if (!projectId) return
    const scope = currentWorkspaceScope(projectId, pageId)
    if (!scope) return
    const max = el.scrollHeight - el.clientHeight
    const record: DetailView = {
      version: 1, kind: 'detail', objectId: id, groups: [...groups],
      scroll: { top: el.scrollTop, ratio: scrollRatio(el.scrollTop, max), outerTop: 0, outerRatio: 0 },
    }
    workspaceViews.put(scope, record)
  }, [pageId])

  // 离页（App 调用）时补记一次：滚动已由下面的监听记过，这里主要兜住「刚折叠完就走」
  useEffect(() => registerWorkspaceCapture(() => {
    const { objectId: id, expanded: groups } = live.current
    write(id, groups, scrollRef.current)
  }), [write, scrollRef])

  // 滚动停下就记（只在内存里，不写任何持久层）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (writeTimer.current) clearTimeout(writeTimer.current)
      writeTimer.current = setTimeout(() => {
        const { objectId: id, expanded: groups } = live.current
        write(id, groups, el)
      }, SETTLE_MS)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (writeTimer.current) clearTimeout(writeTimer.current)
    }
  }, [write, scrollRef])

  const toggle = useCallback((groupId: string, open: boolean) => {
    // 🔴 程序化改 `open`（恢复记录）也会触发 toggle 事件；那不是作者操作，既不该记也不该作废恢复。
    if (live.current.expanded.has(groupId) === open) return
    restoreToken.current += 1 // 作者自己动手：作废在途恢复
    setExpanded(prev => {
      const next = new Set(prev)
      if (open) next.add(groupId)
      else next.delete(groupId)
      write(live.current.objectId, next, scrollRef.current)
      return next
    })
  }, [write, scrollRef])

  // 切对象 / 首次进入：读记录决定哪些组展开、滚到哪
  useEffect(() => {
    if (!objectId) { setExpanded(new Set(defaultGroups)); return }
    const projectId = db.getCurrentProjectId()
    if (!projectId) { setExpanded(new Set(defaultGroups)); return }
    const scope = currentWorkspaceScope(projectId, pageId)
    if (!scope) { setExpanded(new Set(defaultGroups)); return }
    const generation = workspaceViews.generation()
    const record = workspaceViews.get(scope, objectId)
    const usable = record && record.kind === 'detail' && record.objectId === objectId ? record : null
    const nextGroups = new Set(usable && usable.groups.length ? usable.groups : defaultGroups)
    setExpanded(prev => (groupsEqual(prev, nextGroups) ? prev : nextGroups))
    if (!usable) return
    const el = scrollRef.current
    if (!el) return
    const token = restoreToken.current + 1
    restoreToken.current = token
    const cancelled = () => token !== restoreToken.current || workspaceViews.generation() !== generation
    void (async () => {
      await settle(el, cancelled)
      if (cancelled()) return
      const max = el.scrollHeight - el.clientHeight
      // 分组展开会影响高度：宽高都变了就别硬套像素，用比例
      el.scrollTop = max > 0 ? Math.round(usable.scroll.ratio * max) : 0
    })().catch(() => { /* 可选能力，失败不影响阅读 */ })
    // 默认分组由调用方按当前模板算出，模板/页签变化时会换引用 —— 不放进依赖，避免反复重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, pageId, scrollRef])

  return { expanded, toggle }
}
