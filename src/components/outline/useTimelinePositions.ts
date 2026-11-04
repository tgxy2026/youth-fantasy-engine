import { useMemo } from 'react'
import { cappedPositions } from '@/lib/app/storyDate'

/** 时间轴相邻时间点组的间距（历史事件轴 / 故事时间轴同口径） */
export const TIMELINE_SLOT_W = 240

/**
 * 时间轴横轴定位（2.7.2「等比」模式，历史事件轴与故事时间轴共用）。
 *
 * · `even`（默认，零回归）= 等距槽位；
 * · `proportional` = 按真实时间差排布 + 超长空档封顶（否则一个三千年空档会把轴撑爆）；
 *   无法解析时间的组（key=Infinity）排在末尾、按等距兜底。
 *
 * 两个时间轴此前各抄了一份同样的 useMemo（15 行），改一处容易漏另一处，故收敛到这里。
 */
export function useTimelinePositions(
  groups: readonly { key: number }[],
  scale: 'even' | 'proportional',
  slot = TIMELINE_SLOT_W,
) {
  return useMemo(() => {
    const n = groups.length
    const even = () => ({ groupPositions: groups.map((_, gi) => gi * slot + slot / 2), breakIdx: [] as number[] })
    if (scale === 'even' || n === 0) return even()
    const keys: number[] = []
    const back: number[] = []
    groups.forEach((g, gi) => { if (Number.isFinite(g.key)) { keys.push(g.key); back.push(gi) } })
    if (keys.length === 0) return even()
    const { x, breaks } = cappedPositions(keys, { slot })
    const pos = new Array<number>(n).fill(0)
    back.forEach((gi, j) => { pos[gi] = x[j] })
    let cursor = x[x.length - 1]
    for (let gi = 0; gi < n; gi++) if (!Number.isFinite(groups[gi].key)) { cursor += slot; pos[gi] = cursor }
    return { groupPositions: pos, breakIdx: breaks.map(i => back[i]) }
  }, [groups, scale, slot])
}