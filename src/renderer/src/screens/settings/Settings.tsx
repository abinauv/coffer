/*
 * Settings: how Coffer looks and how you move around it, on this computer.
 *
 * EVERY CHOICE TAKES EFFECT AS IT IS MADE. There is no Save button, because there is nothing
 * to hold back: each control writes the same store the shell reads, so the layout, the
 * theme or the density changes under the pointer that chose it.
 *
 * REGISTERED IN BOTH AREAS. The theme is a question somebody has at the unlock screen as
 * much as inside the books, so the title bar opens this screen with no company open too.
 * Nothing here is about a company, and nothing here reaches main: these are preferences of
 * this installation, kept in localStorage for the reasons store/theme.tsx gives.
 *
 * ONLY WHAT IS BUILT IS OFFERED. Two navigation layouts exist, so two are drawn; one key
 * map exists, so the keyboard is described rather than picked from a list of one. A picker
 * with a single entry promises a second, and no language is offered until a translation
 * exists (design plan D6).
 */

import { useId } from 'react'
import type { JSX, ReactNode } from 'react'
import { Icon, Kbd, type IconName } from '@renderer/components/atoms'
import { DENSITY_LABELS, DENSITY_PREFERENCES, type DensityPreference } from '@renderer/lib/density'
import type { Shortcut } from '@renderer/lib/keys'
import {
  NARROW_VIEWPORT_MAX_PX,
  NAVIGATION_LAYOUTS,
  type NavigationLayout,
} from '@renderer/lib/layout'
import { SETTINGS_SCREEN_ID, type AppArea } from '@renderer/lib/routing'
import { registerScreens } from '@renderer/lib/screens'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from '@renderer/lib/theme'
import { useDensity } from '@renderer/store/density'
import { useNavigation } from '@renderer/store/navigation'
import { useNavigationLayout } from '@renderer/store/navigation-layout'
import { useTheme } from '@renderer/store/theme'
import { ScreenFrame } from '../components/ScreenFrame'

const LAYOUTS: Readonly<Record<NavigationLayout, { name: string; body: string }>> = {
  sections: {
    name: 'Section bar and rail',
    body: 'Six sections across the top; the rail beside the screen lists only the screens in the one you are in.',
  },
  icons: {
    name: 'Icon rail',
    body: 'The same, with the rail drawn as icons. Each one names its screen when you point at it, and the screen gets the width back.',
  },
}

const THEME_ICONS: Readonly<Record<ThemePreference, IconName>> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
}

/* The keys most people reach for first. Every other one is in the palette, beside the
 * command it runs. */
const KEYS: readonly { shortcut: Shortcut; does: string }[] = [
  { shortcut: SHORTCUTS.palette, does: 'Search or run any command' },
  { shortcut: SHORTCUTS.create, does: 'New, of the kind on screen' },
  { shortcut: SHORTCUTS.save, does: 'Save' },
  { shortcut: SHORTCUTS.accept, does: 'Issue a document, or record a receipt or payment' },
  { shortcut: SHORTCUTS.search, does: 'Search the register or list on screen' },
  { shortcut: SHORTCUTS.toggleRail, does: 'Switch between the two navigation layouts' },
]

export function Settings({ area }: { area: AppArea }): JSX.Element {
  const { canGoBack, back } = useNavigation()
  const isWorkspace = area === 'workspace'

  return (
    <ScreenFrame
      isInset={isWorkspace}
      width="form"
      title="Settings"
      lede="How Coffer looks and how you move around it, on this computer. Each change takes effect as you make it, for every company opened here."
      {...(!isWorkspace && canGoBack ? { back: { label: 'Back', onClick: back } } : {})}
    >
      <div className="stack settings">
        <NavigationChoice />
        <div className="settings__pair">
          <div className="stack stack--tight">
            <ThemeChoice />
            <DensityChoice />
          </div>
          <Keyboard />
        </div>
      </div>
    </ScreenFrame>
  )
}

function NavigationChoice(): JSX.Element {
  const { layout, isChosen, setLayout } = useNavigationLayout()
  const name = useId()
  const hintId = useId()

  return (
    <fieldset className="settings__group" aria-describedby={hintId}>
      <legend className="settings__legend">
        <h2 className="settings__heading">Navigation</h2>
      </legend>
      <p className="settings__hint" id={hintId}>
        How you move between the six sections and their screens.
        {!isChosen &&
          ` Until you choose, a window narrower than ${NARROW_VIEWPORT_MAX_PX} pixels shows the icon rail.`}
      </p>
      <div className="settings__layouts">
        {NAVIGATION_LAYOUTS.map((option) => (
          <LayoutCard
            key={option}
            layout={option}
            name={name}
            isChecked={option === layout}
            onChoose={() => setLayout(option)}
          />
        ))}
      </div>
    </fieldset>
  )
}

function LayoutCard({
  layout,
  name,
  isChecked,
  onChoose,
}: {
  layout: NavigationLayout
  name: string
  isChecked: boolean
  onChoose: () => void
}): JSX.Element {
  const inputId = useId()
  const bodyId = useId()

  /* THE LABEL HOLDS THE NAME AND NOTHING ELSE. The description is the card's too, but text
   * inside a <label> joins the radio's accessible name, and "Icon rail The same, with the
   * rail drawn as icons…" is not a name. It reaches the radio by `aria-describedby`, and
   * the label stretches over the whole card in CSS so the card is still one target. */
  return (
    <div className="settings__layout" data-checked={isChecked ? 'true' : 'false'}>
      <LayoutDiagram layout={layout} />
      <div className="settings__layout-name">
        <input
          id={inputId}
          type="radio"
          name={name}
          className="settings__radio"
          checked={isChecked}
          aria-describedby={bodyId}
          onChange={onChoose}
        />
        <label className="settings__layout-label" htmlFor={inputId}>
          {LAYOUTS[layout].name}
        </label>
      </div>
      <p className="settings__layout-body" id={bodyId}>
        {LAYOUTS[layout].body}
      </p>
    </div>
  )
}

/* A picture of the frame, drawn from the tokens so it is in the theme it describes. Hidden
 * from assistive technology: the name and the sentence under it say the same thing. */
function LayoutDiagram({ layout }: { layout: NavigationLayout }): JSX.Element {
  return (
    <div className="layout-diagram" data-layout={layout} aria-hidden="true">
      <div className="layout-diagram__title" />
      <div className="layout-diagram__sections">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} data-active={index === 3 ? 'true' : 'false'} />
        ))}
      </div>
      <div className="layout-diagram__body">
        <div className="layout-diagram__rail">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} data-active={index === 0 ? 'true' : 'false'} />
          ))}
        </div>
        <div className="layout-diagram__screen" />
      </div>
    </div>
  )
}

function ThemeChoice(): JSX.Element {
  const { preference, setPreference } = useTheme()
  return (
    <SegmentedChoice
      legend="Theme"
      hint="Follow system changes whenever your computer switches between light and dark."
      options={THEME_PREFERENCES.map((option) => ({
        value: option,
        label: THEME_LABELS[option],
        icon: THEME_ICONS[option],
      }))}
      value={preference}
      onChange={setPreference}
    />
  )
}

function DensityChoice(): JSX.Element {
  const { preference, setPreference } = useDensity()
  return (
    <SegmentedChoice<DensityPreference>
      legend="Density"
      hint="Compact fits more rows on screen. Nothing gets smaller to read."
      options={DENSITY_PREFERENCES.map((option) => ({
        value: option,
        label: DENSITY_LABELS[option],
      }))}
      value={preference}
      onChange={setPreference}
    />
  )
}

interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: IconName
}

/* Native radios, drawn as segments. The input stays in the page, so arrow keys move the
 * choice and a screen reader hears "radio, 2 of 3" rather than a row of buttons that
 * happen to look pressed. */
function SegmentedChoice<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  legend: string
  hint: ReactNode
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
}): JSX.Element {
  const name = useId()
  const hintId = useId()

  return (
    <fieldset className="settings__group" aria-describedby={hintId}>
      <legend className="settings__legend">
        <h2 className="settings__heading">{legend}</h2>
      </legend>
      <div className="segments">
        {options.map((option) => (
          <label key={option.value} className="segments__option">
            <input
              type="radio"
              name={name}
              className="segments__input visually-hidden"
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            {option.icon !== undefined && <Icon name={option.icon} size={14} />}
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p className="settings__hint" id={hintId}>
        {hint}
      </p>
    </fieldset>
  )
}

function Keyboard(): JSX.Element {
  const headingId = useId()
  return (
    <section className="settings__group" aria-labelledby={headingId}>
      <h2 className="settings__heading" id={headingId}>
        Keyboard
      </h2>
      <p className="settings__hint">
        The keys most programs use. Every command in the palette shows its own.
      </p>
      <dl className="settings__keys">
        {KEYS.map((entry) => (
          <div key={entry.does} className="settings__key">
            <dt>
              <Kbd shortcut={entry.shortcut} />
            </dt>
            <dd>{entry.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

registerScreens([
  {
    id: SETTINGS_SCREEN_ID,
    title: 'Settings',
    area: 'workspace',
    nav: { label: 'Settings', icon: 'settings', group: 'company', order: 9 },
    render: () => <Settings area="workspace" />,
  },
  /* No rail before a company is open. The title bar's button and the palette reach it. */
  {
    id: SETTINGS_SCREEN_ID,
    title: 'Settings',
    area: 'welcome',
    render: () => <Settings area="welcome" />,
  },
])
