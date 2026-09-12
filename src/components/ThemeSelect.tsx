'use client'

import { useSyncExternalStore } from 'react'
import { THEMES, applyTheme, isThemeId, readTheme, subscribeTheme } from '@/lib/theme'

const serverSnapshot = () => 'system' as const

export default function ThemeSelect() {
  // localStorage is not on the server, so the server and the hydration pass
  // render `system`; the stored choice takes over on the client's first snapshot.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverSnapshot)
  return (
    <select
      id="theme"
      className="settingsSelect"
      value={theme}
      onChange={e => {
        if (isThemeId(e.target.value)) applyTheme(e.target.value)
      }}
    >
      {THEMES.map(t => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  )
}
