import assert from 'node:assert/strict'
import { computeRowWindow } from '../src/components/sheets/useRowWindow'

let passed = 0
function test(name: string, fn: () => void) { fn(); passed++; console.log('PASS ' + name) }

const uniform = (h: number) => () => h
/** 占位合计 + 窗口内高度 = 总高：表格高度不能被虚拟化改掉，否则滚动条会跳 */
function invariants(range: { start: number; end: number; topPad: number; bottomPad: number }, count: number, heightAt: (i: number) => number) {
  let total = 0, inWindow = 0
  for (let i = 0; i < count; i++) total += heightAt(i)
  for (let i = range.start; i < range.end; i++) inWindow += heightAt(i)
  assert.ok(range.start >= 0 && range.start <= range.end && range.end <= count, '区间越界')
  assert.equal(range.topPad + inWindow + range.bottomPad, total, '占位合计与总高不符')
}

test('空表 / 非法行数返回空区间', () => {
  assert.deepEqual(computeRowWindow({ count: 0, heightAt: uniform(50), viewportTop: 0, viewportHeight: 500 }), { start: 0, end: 0, topPad: 0, bottomPad: 0 })
  assert.deepEqual(computeRowWindow({ count: -3, heightAt: uniform(50), viewportTop: 0, viewportHeight: 500 }), { start: 0, end: 0, topPad: 0, bottomPad: 0 })
})

test('停在顶部：从第 0 行开始，上方无占位', () => {
  const count = 300, h = 50
  const range = computeRowWindow({ count, heightAt: uniform(h), viewportTop: 0, viewportHeight: 500, overscan: 4 })
  assert.equal(range.start, 0)
  assert.equal(range.topPad, 0)
  // 视口 500 / 行高 50 = 10 行 + overscan
  assert.equal(range.end, 10 + 4)
  assert.equal(range.bottomPad, (count - range.end) * h)
  invariants(range, count, uniform(h))
})

test('滚到底：最后一行必须在窗口里（否则「滚到底看末行」永远等不到）', () => {
  const count = 300, h = 50
  const total = count * h
  const range = computeRowWindow({ count, heightAt: uniform(h), viewportTop: total - 500, viewportHeight: 500, overscan: 4 })
  assert.equal(range.end, count)
  assert.equal(range.bottomPad, 0)
  // 真正该守的不变量：挂着这么多行才能盖住一屏（10 行）+ 上下 overscan，外加首个与视口相交的那一行
  assert.ok(range.end - range.start <= 10 + 4 * 2 + 1, `挂载行数失控：${range.end - range.start}`)
  assert.ok(range.start <= count - 10, '最后一个视口内的行必须都在窗口里')
  invariants(range, count, uniform(h))
})

test('变高行：占位按各自高度累加，不按平均值糊弄', () => {
  const heights = [40, 120, 78, 40, 200, 40, 40, 90]
  const [count, heightAt] = [heights.length, (i: number) => heights[i]] as const
  const range = computeRowWindow({ count, heightAt, viewportTop: 0, viewportHeight: 260, overscan: 0 })
  // 累计到第 2 行是 238 < 260，第 3 行（238~278）与视口相交 ⇒ 窗口到 4 行为止
  assert.equal(range.end, 4)
  assert.equal(range.topPad, 0)
  // 4 行之后剩下的：200 + 40 + 40 + 90
  assert.equal(range.bottomPad, 370)
  invariants(range, count, heightAt)
})

test('钉住行（跳转聚焦）：近处拉伸、远处绝不把上千行拉进 DOM', () => {
  const count = 1000, h = 50
  // 视口在第 800 行附近，钉住第 780 行（差 15 行）⇒ 应该被拉进窗口
  const near = computeRowWindow({ count, heightAt: uniform(h), viewportTop: 40000, viewportHeight: 500, overscan: 2, pinnedIndex: 780, pinLimit: 60 })
  assert.equal(near.start, 780)
  assert.ok(near.end - near.start <= 60 + 10 + 4, `近处拉伸挂得太多：${near.end - near.start}`)
  invariants(near, count, uniform(h))

  // 视口在顶部、钉住第 900 行（差 900 行）⇒ **不许**拉伸，否则虚拟化白做
  const far = computeRowWindow({ count, heightAt: uniform(h), viewportTop: 0, viewportHeight: 500, overscan: 2, pinnedIndex: 900, pinLimit: 60 })
  assert.ok(far.end - far.start <= 10 + 4 + 1, `远处钉住把窗口撑爆了：${far.end - far.start} 行`)
  assert.ok(far.end <= 901, '远处钉住不应把目标行强行挂进 DOM')
  invariants(far, count, uniform(h))

  // 钉住行与视口重叠时（最常见）：窗口不受影响
  const inside = computeRowWindow({ count, heightAt: uniform(h), viewportTop: 40000, viewportHeight: 500, overscan: 2, pinnedIndex: 805 })
  const plain = computeRowWindow({ count, heightAt: uniform(h), viewportTop: 40000, viewportHeight: 500, overscan: 2 })
  assert.deepEqual(inside, plain)
})

test('极端：单行比视口还高 / 超高行之后不丢行', () => {
  const heights = [2000, 40, 40, 40]
  const [count, heightAt] = [heights.length, (i: number) => heights[i]] as const
  const range = computeRowWindow({ count, heightAt, viewportTop: 0, viewportHeight: 500, overscan: 0 })
  assert.equal(range.start, 0)
  assert.ok(range.end >= 1)
  invariants(range, count, heightAt)
  // 越过那个超高行后，后面的行必须能被算进窗口
  const past = computeRowWindow({ count, heightAt, viewportTop: 2001, viewportHeight: 500, overscan: 0 })
  assert.ok(past.start >= 1 && past.end >= 2)
  assert.equal(past.topPad, 2000)
  invariants(past, count, heightAt)
})

console.log(`rowWindow：${passed} 通过 / 0 失败`)
