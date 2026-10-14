import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, HardDrive, Settings } from 'lucide-react'
import { Popover } from '../../components/ui/Menu'
import { setUserSettings, useUserSettings } from './settings'
import { THEMES, type ThemePreference } from '../../app/theme'
import './AccountMenu.css'

/**
 * The settings button at the foot of the sidebar and the menu it opens: a link to This browser (`/browser`, where
 * what aegraph keeps in this browser is stashed, restored and cleared), then the user's settings (`settings.ts`):
 * Third-party services, the one switch over everything that leaves this machine, and Developer tools, which shows the
 * GPU view's Benchmark menu. There is no account: everything is this browser's. On the rail the button is the icon
 * alone.
 */
export function AccountButton({ rail }: { rail: boolean }) {
  // The popover is anchored to the button's rectangle as it was when pressed.
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const open = !!anchor
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`sb-footer ${rail ? 'sb-footer--rail' : ''} ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={rail ? 'Settings' : undefined}
        title={rail ? 'Settings' : undefined}
        onClick={() => setAnchor((a) => (a ? null : (ref.current?.getBoundingClientRect() ?? null)))}
      >
        <span className="sb-avatar">
          <Settings size={16} />
        </span>
        {!rail && (
          <>
            <span className="sb-footer__text">
              <span className="sb-footer__name">Settings</span>
              <span className="sb-footer__meta">Storage and privacy</span>
            </span>
            <ChevronDown size={16} className="sb-footer__chevron" />
          </>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={288}>
          <AccountPanel onNavigate={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  )
}

/** The menu's contents: the link to This browser, then the settings. */
export function AccountPanel({ onNavigate }: { onNavigate?: () => void } = {}) {
  const settings = useUserSettings()
  return (
    <div className="acct" role="dialog" aria-label="Settings">
      <Link className="btn btn--sm acct__browser" to="/browser" onClick={onNavigate}>
        <HardDrive size={13} /> This browser — stash, restore, clear
      </Link>
      <div className="acct__sep" />
      <div className="acct__label">Settings</div>
      <ThemePicker value={settings.theme} onChange={(theme) => setUserSettings({ theme })} />
      <label className="acct__toggle">
        <input type="checkbox" checked={settings.externalServices} onChange={(e) => setUserSettings({ externalServices: e.target.checked })} />
        <span className="acct__toggle-text">
          <span>Third-party services</span>
          <span className="muted">
            Map tiles, place search, Wikipedia, search by meaning, YouTube and Spotify players, linked-data import. Off is offline mode: nothing but this site is called, and your work is untouched.{' '}
            <Link to="/docs/privacy" onClick={onNavigate}>
              What is sent
            </Link>
          </span>
        </span>
      </label>
      <label className="acct__toggle">
        <input type="checkbox" checked={settings.developerTools} onChange={(e) => setUserSettings({ developerTools: e.target.checked })} />
        <span className="acct__toggle-text">
          <span>Developer tools</span>
          <span className="muted">Tools for working on aegraph itself: the graph view's Benchmark menu.</span>
        </span>
      </label>
    </div>
  )
}

/** The theme choice: the operating system's light or dark, or one of the themes, each shown by its colours. */
function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (t: ThemePreference) => void }) {
  const options: { id: ThemePreference; label: string; title: string; swatch: readonly string[] }[] = [
    { id: 'system', label: 'System', title: 'Light or dark, as your operating system is set', swatch: [THEMES[0].swatch[0], THEMES[1].swatch[0], THEMES[1].swatch[2]] },
    ...THEMES.map((t) => ({ id: t.id, label: t.label, title: t.description, swatch: t.swatch })),
  ]
  return (
    <div className="acct__theme">
      <span className="acct__theme-label">Theme</span>
      <div className="acct__themes" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`acct__theme-opt ${value === o.id ? 'is-on' : ''}`} title={o.title} onClick={() => onChange(o.id)}>
            <span className="acct__swatch" aria-hidden style={{ background: o.swatch[0], borderColor: o.swatch[1] }}>
              <span style={{ background: o.swatch[1] }} />
              <span style={{ background: o.swatch[2] }} />
            </span>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
