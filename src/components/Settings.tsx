import { GearIcon } from '@primer/octicons-react'
import ThemeSelect from './ThemeSelect'

/**
 * A gear in the top bar opening a popover. The Popover API does the opening,
 * light-dismiss and Escape, so the only client code here is the select.
 */
export default function Settings() {
  return (
    <>
      <button type="button" className="settingsButton" popoverTarget="settings" aria-label="Settings" title="Settings">
        <GearIcon size={16} />
      </button>
      <div id="settings" popover="auto" className="settingsPanel">
        <h2 className="settingsTitle">Settings</h2>
        <div className="settingsField">
          <label htmlFor="theme">Theme</label>
          <ThemeSelect />
        </div>
        <p className="settingsHint">System follows the Mac&apos;s appearance: GitHub light, or Monokai Classic in dark.</p>
      </div>
    </>
  )
}
