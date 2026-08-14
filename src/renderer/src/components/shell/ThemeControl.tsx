import type { JSX } from 'react'
import { BRAND } from '../../../../branding'
import { THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from '../../lib/theme'
import { useTheme } from '../../store/theme'
import { Icon, type IconName } from '../atoms'

const ICONS: Readonly<Record<ThemePreference, IconName>> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
}

interface ThemeControlProps {
  /** Compact drops the labels and shows icons only. Used in the title bar. */
  isCompact?: boolean
}

/**
 * The theme control: system, light, dark.
 *
 * A three-way radio group rather than a two-way toggle, because "follow the
 * system" is a real preference and not the absence of one — a toggle forces the
 * user to pick a side and then leaves them pinned to it when the OS changes at
 * dusk. Radio semantics also mean arrow keys work and the current value is
 * announced, which a cycling button cannot manage.
 */
export function ThemeControl({ isCompact = false }: ThemeControlProps): JSX.Element {
  const { preference, setPreference } = useTheme()

  return (
    <div
      className={['theme-control', isCompact ? 'theme-control--compact' : '']
        .filter(Boolean)
        .join(' ')}
      role="radiogroup"
      aria-label={`${BRAND.name} appearance`}
    >
      {THEME_PREFERENCES.map((option) => {
        const isSelected = option === preference
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={THEME_LABELS[option]}
            title={THEME_LABELS[option]}
            className="theme-control__option focus-inset"
            /* Only the selected option is in the tab order; arrows move within
             * the group. That is what a radio group is supposed to do. */
            tabIndex={isSelected ? 0 : -1}
            onClick={() => setPreference(option)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0
              const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
              if (step === 0 && back === 0) return
              event.preventDefault()
              const index = THEME_PREFERENCES.indexOf(preference)
              const count = THEME_PREFERENCES.length
              const next = THEME_PREFERENCES[(index + step + back + count) % count]
              if (next) setPreference(next)
            }}
          >
            <Icon name={ICONS[option]} size={14} />
            {!isCompact && <span>{THEME_LABELS[option]}</span>}
          </button>
        )
      })}
    </div>
  )
}
