import { applyTheme, applyZoom, getStoredTheme, getStoredZoom } from './theme'
import { applyStoredFontPrefs } from './fontPrefs'
import { installDensityPreferences } from './density'

/** Apply local appearance before the first React frame, including boot and error surfaces. */
export function initializeAppearance(): void {
  applyTheme(getStoredTheme())
  applyZoom(getStoredZoom())
  applyStoredFontPrefs()
  installDensityPreferences()
}
