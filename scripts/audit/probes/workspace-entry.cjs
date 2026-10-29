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
    try {
      await nav.getByRole('button', { name: '正文编辑', exact: true }).click({ timeout: Math.min(1500, Math.max(1, end - Date.now())) })
      return nav
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
      lastError = error
    }
    await page.waitForTimeout(100)
  }
  throw lastError ?? new Error('Workspace navigation did not become actionable')
}

module.exports = { openEditorNavigation }
