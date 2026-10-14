import { Check, Monitor } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { DEFAULT_THEME, SYSTEM_DARK, THEMES, themeInfo, useTheme, type ThemeId, type ThemePreference } from '../../app/theme'
import { closeThemeGallery, useThemeGalleryOpen } from './themeGalleryStore'
import { setUserSettings, useUserSettings } from './settings'
import './ThemeGallery.css'

/**
 * The theme gallery: every theme as a card drawn in its own colours — a small window of the app (a sidebar, a card
 * with its text, a link, the status chips, buttons, a selected row and a bit of graph) — so a theme is chosen by
 * seeing it, not by its name. A card is `[data-theme-preview='<id>']`: the same CSS block that themes the page
 * (`:root[data-theme='<id>'], [data-theme-preview='<id>']`) sets its tokens, so a card is the theme as the app draws
 * it, with nothing copied. A click applies the theme at once; the dialog stays open to compare.
 *
 * Opened from the settings menu at the foot of the sidebar (`openThemeGallery` in `themeGalleryStore.ts`); mounted once by the sidebar
 * (`ThemeGalleryHost`), so it outlives the menu that opened it.
 */
export function ThemeGalleryHost() {
  const isOpen = useThemeGalleryOpen()
  return isOpen ? <ThemeGallery onClose={closeThemeGallery} /> : null
}

function ThemeGallery({ onClose }: { onClose: () => void }) {
  const { theme: pref } = useUserSettings()
  const shown = useTheme()
  const pick = (t: ThemePreference) => setUserSettings({ theme: t })
  // Light themes first in each group, then dark: a dark card between two light ones breaks the row.
  const group = (g: 'aegraph' | 'unigraph') => THEMES.filter((t) => t.group === g && t.scheme === 'light').concat(THEMES.filter((t) => t.group === g && t.scheme === 'dark'))
  return (
    <Dialog open title="Themes" description="Pick how aegraph looks. Each card is the theme itself; a click applies it." onClose={onClose} wide closable className="tgal">
      <button type="button" className={`tgal__system ${pref === 'system' ? 'is-on' : ''}`} aria-pressed={pref === 'system'} onClick={() => pick('system')}>
        <Monitor size={16} aria-hidden />
        <span>
          <strong>System</strong>
          <span className="muted">
            {' '}
            — {themeInfo(DEFAULT_THEME).label} or {themeInfo(SYSTEM_DARK).label}, as your operating system is set{pref === 'system' ? ` (now ${themeInfo(shown).label})` : ''}.
          </span>
        </span>
        {pref === 'system' && <Check size={15} className="tgal__check" aria-hidden />}
      </button>
      <h3 className="tgal__group">aegraph</h3>
      <div className="tgal__grid" role="radiogroup" aria-label="aegraph themes">
        {group('aegraph').map((t) => (
          <ThemeCard key={t.id} id={t.id} on={pref === t.id} onPick={pick} />
        ))}
      </div>
      <h3 className="tgal__group">From Unigraph</h3>
      <div className="tgal__grid" role="radiogroup" aria-label="Unigraph themes">
        {group('unigraph').map((t) => (
          <ThemeCard key={t.id} id={t.id} on={pref === t.id} onPick={pick} />
        ))}
      </div>
    </Dialog>
  )
}

/** The graph's sample nodes keep one palette in every theme: they stand for data colours, which a theme does not change. */
const NODES: [number, number, string][] = [
  [18, 30, '#e76f51'],
  [44, 14, '#2a9d8f'],
  [66, 34, '#e9c46a'],
  [40, 48, '#457b9d'],
  [86, 18, '#8e6bbf'],
  [92, 44, '#2a9d8f'],
]
const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 3],
  [3, 2],
  [2, 4],
  [4, 5],
  [2, 5],
]

function ThemeCard({ id, on, onPick }: { id: ThemeId; on: boolean; onPick: (t: ThemePreference) => void }) {
  const t = themeInfo(id)
  return (
    // The button is drawn in the page's theme (its ring says it is the one chosen); what is inside it, in its own.
    <button type="button" role="radio" aria-checked={on} className={`tcard ${on ? 'is-on' : ''}`} onClick={() => onPick(id)} title={t.description}>
      <span className="tcard__in" data-theme-preview={id}>
      <span className="tcard__win" aria-hidden>
        <span className="tcard__side">
          <i className="tcard__logo" />
          <i className="tcard__nav is-active" />
          <i className="tcard__nav" />
          <i className="tcard__nav" />
          <i className="tcard__nav" />
        </span>
        <span className="tcard__main">
          <span className="tcard__h">Kestrel Energy</span>
          <span className="tcard__sub">3,509 entities · 15,918 links</span>
          <span className="tcard__card">
            <span className="tcard__title">Series B — the story</span>
            <span className="tcard__muted">Cathode chemistry, pilot line</span>
            <span className="tcard__row">
              <span className="tcard__chip tcard__chip--ok">ok</span>
              <span className="tcard__chip tcard__chip--warn">warn</span>
              <span className="tcard__chip tcard__chip--bad">risk</span>
              <span className="tcard__chip tcard__chip--info">info</span>
            </span>
            <span className="tcard__row">
              <span className="tcard__btn tcard__btn--primary">Open</span>
              <span className="tcard__btn">Share</span>
              <span className="tcard__link">Read more</span>
            </span>
          </span>
          <span className="tcard__sel">Selected row</span>
          <svg className="tcard__graph" viewBox="0 0 110 60" preserveAspectRatio="xMidYMid meet">
            {EDGES.map(([a, b], i) => (
              <line key={i} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} className="tcard__edge" />
            ))}
            {NODES.map(([x, y, c], i) => (
              <circle key={i} cx={x} cy={y} r={i === 2 ? 5.5 : 4} style={{ fill: c } as CSSProperties} />
            ))}
            <circle cx={NODES[2][0]} cy={NODES[2][1]} r={8.5} className="tcard__ring" />
            <circle cx={NODES[4][0]} cy={NODES[4][1]} r={6.5} className="tcard__ring tcard__ring--path" />
          </svg>
        </span>
      </span>
      <span className="tcard__foot">
        <span className="tcard__name">{t.label}</span>
        <span className="tcard__scheme">{t.scheme === 'dark' ? 'Dark' : 'Light'}</span>
        {on && <Check size={14} className="tcard__check" aria-hidden />}
      </span>
      </span>
    </button>
  )
}
