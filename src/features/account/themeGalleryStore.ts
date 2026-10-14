import { useSyncExternalStore } from 'react'
import { currentTheme, themeInfo, type ThemeId, type ThemePreference } from '../../app/theme'

/** Whether the theme gallery (`ThemeGallery.tsx`) is open: a store of its own, so the menu that opens it can close. */
let open = false
const listeners = new Set<() => void>()
const set = (v: boolean) => {
  open = v
  listeners.forEach((l) => l())
}
export const openThemeGallery = () => set(true)
export const useThemeGalleryOpen = () => useSyncExternalStore((cb) => (listeners.add(cb), () => void listeners.delete(cb)), () => open, () => open)

export const closeThemeGallery = () => set(false)

/** A preference as the menu names it: the theme, or System with the theme it shows now. */
export function themeLabel(pref: ThemePreference, shown: ThemeId = currentTheme()): string {
  return pref === 'system' ? `System (${themeInfo(shown).label})` : themeInfo(pref).label
}

