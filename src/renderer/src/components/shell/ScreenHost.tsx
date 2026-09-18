/*
 * Renders whichever screen the current route names.
 *
 * When nothing matches, the placeholder below says exactly what is missing and how
 * to supply it. A shell that renders a blank pane when a route has no screen is a
 * shell that costs somebody an afternoon.
 *
 * IT ALSO CATCHES THE KEYBOARD. Activating "New sales invoice" removes that button from the
 * page, and a browser answers that by putting focus on the body: the next Tab then starts
 * at the skip link, and a keyboard user walks the title bar, the section bar and the whole
 * rail again before reaching the screen they just opened (B38 in the design plan). So a new
 * screen takes focus itself — but only when nothing in it has claimed focus already, which
 * is why the effect below reads `document.activeElement` instead of focusing unconditionally.
 * A screen that puts the caret in its first field, as the create form does, keeps it.
 */

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { Route } from '../../lib/routing'
import { describeLocation, findScreen } from '../../lib/screens'
import { CommandLocation } from '../../store/commands'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'
import { Icon } from '../atoms'

export function ScreenHost(): JSX.Element {
  const screens = useScreens()
  const { route, navigate } = useNavigation()
  const screen = findScreen(screens, route.area, route.screenId)
  const frame = useRef<HTMLDivElement>(null)
  const key = screenKey(route)
  /* The screen on show when the window opened. Focus moves on a CHANGE of screen and never
   * on the first one: a window that has just opened should answer its first Tab with the
   * skip link, as every other page does. */
  const shown = useRef(key)

  /* Effects run from the inside out, so a screen that focuses a field of its own has
   * already done it by the time this runs, and this leaves it alone. */
  useEffect(() => {
    if (shown.current === key) return
    shown.current = key
    const active = document.activeElement
    if (active === null || active === document.body) {
      frame.current?.focus({ preventScroll: true })
    }
  }, [key])

  if (!screen) return <MissingScreen area={route.area} screenId={route.screenId} />

  return (
    <>
      {/* `tabIndex={-1}` so it can be focused without joining the tab order. */}
      <div key={key} ref={frame} tabIndex={-1} className="screen">
        <CommandLocation
          location={describeLocation(screens, route.area, route.screenId) ?? screen.title}
        >
          {screen.render({ route, navigate })}
        </CommandLocation>
      </div>
    </>
  )
}

/**
 * The identity a screen is mounted under.
 *
 * A screen remounts when this string changes and survives when it does not, so the
 * function has to be right in BOTH directions and the two are different mistakes.
 *
 * IT INCLUDES THE PARAMETERS, which until 0016 it did not — the comment here said it
 * did and the key said `area/screenId`. Navigating from one document to the next
 * therefore kept the mounted screen, and every editor in the product loads its record
 * into local state on mount: one record's figures under another's heading, which is the
 * exact sentence this key was written to prevent.
 *
 * THE ENTRIES ARE SORTED, because insertion order is not identity. `{ partyId, documentId }`
 * and `{ documentId, partyId }` name one record, and two call sites will write them in
 * two orders sooner or later; a key that changed between them would tear a screen down
 * mid-edit and lose what had been typed into it. Sorting is not a tidiness measure here
 * — it is what makes the key a function of the route rather than of the code that built
 * it.
 *
 * THE PARTS ARE ESCAPED, because joining on `=` and `&` cannot tell
 * `{ id: 'x&kind=sales' }` from `{ id: 'x', kind: 'sales' }`. Two different records
 * under one key is the original bug again, just harder to see.
 *
 * NO PARAMETERS AND AN EMPTY SET OF THEM ARE ONE STATE, NOT TWO. `makeRoute` defaults
 * `params` to `{}`, so a nav item that omits the argument and a command that passes
 * `{}` hand this the same value; the query part is appended unconditionally so that
 * both spell the same key, rather than one growing a suffix the other lacks.
 *
 * It says the same thing as `isSameRoute` in lib/routing.ts and must not drift from it:
 * that one answers "is this a new history entry", this one answers "is this a new
 * screen", and they are the same question about the same three fields.
 */
function screenKey(route: Route): string {
  const params = Object.entries(route.params)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')

  return `${route.area}/${route.screenId}?${params}`
}

function MissingScreen({ area, screenId }: { area: string; screenId: string }): JSX.Element {
  return (
    <div className="screen screen--missing">
      <div className="missing-screen">
        <Icon name="question" size={22} />
        <h1 className="missing-screen__title">No screen registered for this route</h1>
        <p className="missing-screen__body">
          The route is <code>{area}</code> / <code>{screenId}</code>. A module under{' '}
          <code>src/renderer/src/screens/</code> supplies it by calling <code>registerScreens</code>{' '}
          with a definition whose <code>area</code> and <code>id</code> match.
        </p>
      </div>
    </div>
  )
}
