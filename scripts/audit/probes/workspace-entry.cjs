'use strict'

// Preparation only: startup reminders can asynchronously make the background navigation inert.
// Dismiss only known startup reminders, then require a real, actionable editor navigation control.
// A late reminder between the visibility check and click is retried within the same bounded deadline.
async function openEditorNavigation(page, timeout = 45000) {
  await page.locator('nav').first().waitFor({ state: 'attached', timeout })
  const nav = page.getByRole('navigation').first()
  const end = Date.now() + timeout
  let lastError
  while (Date.now() < end) {
    for (const name of ['稍后再说', '知道了', '我知道了']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if (await button.isVisible()) await button.click({ timeout: Math.min(1500, Math.max(1, end - Date.now())) })
    }
    /**
     * 🔴 页签引导卡（`[data-guide-card]`）是 fixed 浮层，会**正好压住**左侧导航按钮：
     *    实测中心点命中的是 `div.fixed`，于是 45 秒里每次点击都被它拦掉（诊断输出 guides 里就是它）。
     *    它上面没有「稍后再说」，只有「跳过本页」—— 不处理就会一直挡住。
     */
    const guide = page.locator('[data-guide-card]').first()
    if (await guide.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).first()
        .click({ timeout: Math.min(1500, Math.max(1, end - Date.now())) }).catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
    try {
      await nav.getByRole('button', { name: '正文编辑', exact: true }).click({ timeout: Math.min(1500, Math.max(1, end - Date.now())) })
      return nav
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
      lastError = error
    }
    await page.waitForTimeout(100)
  }
  /**
   * 🔴 45 秒里每次 1.5s 点击都超时 ⇒ 不是「偶尔被挡」，是**持续不可点**。
   * 光抛出「Timeout」没法定位，这里在放弃前把现场抓下来：按钮是否 disabled、尺寸、
   * 覆盖在它中心点上的是谁、以及截图。有了这几样才能判断是遮挡、是禁用、还是根本没渲染出来。
   */
  try {
    const diag = await page.evaluate(() => {
      const nav = document.querySelector('nav')
      const buttons = nav ? [...nav.querySelectorAll('button')] : []
      const target = buttons.find(b => (b.textContent || '').trim() === '正文编辑')
      if (!target) {
        return { found: false, navButtons: buttons.map(b => (b.textContent || '').trim()).slice(0, 20) }
      }
      const rect = target.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2)
      const top = document.elementFromPoint(cx, cy)
      const describe = el => (el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
        `${el.getAttribute && el.getAttribute('data-guide') ? '[data-guide=' + el.getAttribute('data-guide') + ']' : ''}` +
        `.${(el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : 'null')
      return {
        found: true,
        disabled: target.disabled === true,
        ariaDisabled: target.getAttribute('aria-disabled'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        centerHit: describe(top),
        isSelf: !!(top && (top === target || target.contains(top))),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(describe).slice(0, 4),
        guides: [...document.querySelectorAll('[data-guide-card]')].map(describe).slice(0, 2),
      }
    })
    if (page.screenshot) {
      const shot = `workspace-entry-fail-${Date.now()}.png`
      await page.screenshot({ path: shot }).catch(() => {})
      diag.screenshot = shot
    }
    lastError = new Error(`Workspace navigation did not become actionable: ${JSON.stringify(diag)}`)
  } catch (e) {
    lastError = lastError ?? e
  }
  throw lastError ?? new Error('Workspace navigation did not become actionable')
}

module.exports = { openEditorNavigation }
