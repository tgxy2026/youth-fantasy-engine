'use strict'

// Probe-only coordination. Production save functions still run and return their actual result.
function createSaveBarrier() {
  let paused = false, active = 0
  const waiting = new Set(), draining = new Set()
  return {
    get state() { return { paused, active, waiting: waiting.size } },
    async run(save) {
      while (paused) await new Promise(resolve => waiting.add(resolve))
      active++
      try { return await save() }
      finally {
        active--
        if (!active) { for (const resolve of draining) resolve(); draining.clear() }
      }
    },
    async pause() {
      if (paused) throw new Error('Save barrier already owned')
      paused = true
      if (active) await new Promise(resolve => draining.add(resolve))
    },
    resume() {
      if (active) throw new Error('Cannot release save barrier before active writes finish')
      paused = false
      for (const resolve of waiting) resolve()
      waiting.clear()
    },
  }
}
module.exports = { createSaveBarrier }
