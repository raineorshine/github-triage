/**
 * Named palettes the Settings panel switches between. `system` is the absence
 * of a choice: `:root` in globals.css follows the Mac's appearance. Every other
 * id is a `[data-theme]` block there — a theme is added in both places.
 *
 * The choice is the one thing the app keeps in the browser (AGENTS.md
 * "Constraints"): localStorage, read by the boot script in the root layout
 * before first paint and by the panel, never by the server.
 */
export const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'github-light', label: 'GitHub light' },
  { id: 'monokai-classic', label: 'Monokai Classic' },
  { id: 'monokai', label: 'Monokai' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

export const THEME_KEY = 'theme'

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some(t => t.id === value)
}

/**
 * Inlined ahead of the body so the first paint is already themed. It cannot
 * import anything, so it mirrors setAttribute below by hand; an id it does not
 * know matches no block and falls back to `system`.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t&&t!=='system')document.documentElement.dataset.theme=t}catch(e){}`

export function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeId(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function setAttribute(id: ThemeId) {
  if (id === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = id
}

const listeners = new Set<() => void>()

/** For useSyncExternalStore: fires on applyTheme here and on a change in another tab. */
export function subscribeTheme(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_KEY) return
    setAttribute(readTheme())
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function applyTheme(id: ThemeId) {
  try {
    if (id === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, id)
  } catch {
    // Storage refused (private mode): the page still changes, the choice does not outlive it.
  }
  setAttribute(id)
  listeners.forEach(l => l())
}
