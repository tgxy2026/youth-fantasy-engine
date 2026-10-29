import { PREF_EVENT, clearEnumSession, readEnumPref } from './uiPrefs'

export const DENSITIES = ['compact', 'comfortable'] as const
export type Density = typeof DENSITIES[number]
export const DENSITY_PREF = 'density'
export const DENSITY_CHANGED = 'yfe:density-changed'

/** Missing/old/corrupt values preserve the compact baseline; UI density never changes manuscript settings. */
export function normalizeDensity(value: unknown): Density {
  return value === 'comfortable' ? 'comfortable' : 'compact'
}

export function getStoredDensity(): Density {
  return readEnumPref(DENSITY_PREF, DENSITIES, 'compact')
}

export function applyDensity(value: unknown): Density {
  const density = normalizeDensity(value)
  if (typeof document === 'undefined') return density
  const previous = document.documentElement.dataset.density
  document.documentElement.dataset.density = density
  // Consumers invalidate measured geometry only after the density attribute has changed.
  if (previous !== density && typeof window !== 'undefined') window.dispatchEvent(new Event(DENSITY_CHANGED))
  return density
}

/** One application-lifetime subscription, installed before React mounts. Returns cleanup for isolated tests. */
export function installDensityPreferences(): () => void {
  applyDensity(getStoredDensity())
  const sync = (e: Event) => {
    if (e.type === 'storage') {
      if ((e as StorageEvent).key === 'yfe-ui:' + DENSITY_PREF || (e as StorageEvent).key === null) {
        clearEnumSession(DENSITY_PREF)
        applyDensity(getStoredDensity())
      }
    } else {
      const detail = (e as CustomEvent<{ key: string; value?: unknown }>).detail
      if (detail?.key === DENSITY_PREF) applyDensity(detail.value === undefined ? getStoredDensity() : detail.value)
    }
  }
  window.addEventListener(PREF_EVENT, sync)
  window.addEventListener('storage', sync)
  return () => {
    window.removeEventListener(PREF_EVENT, sync)
    window.removeEventListener('storage', sync)
  }
}
