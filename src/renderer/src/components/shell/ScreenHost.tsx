/*
 * Renders whichever screen the current route names.
 *
 * When nothing matches, the placeholder below says exactly what is missing and how
 * to supply it. A shell that renders a blank pane when a route has no screen is a
 * shell that costs somebody an afternoon.
 */

import type { JSX } from 'react'
import { findScreen } from '../../lib/screens'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'
import { Icon } from '../atoms'

export function ScreenHost(): JSX.Element {
  const screens = useScreens()
  const { route, navigate } = useNavigation()
  const screen = findScreen(screens, route.area, route.screenId)

  if (!screen) return <MissingScreen area={route.area} screenId={route.screenId} />

  return (
    <>
      {/* Keyed on the route so a screen remounts when its parameters change,
          rather than showing one record's figures under another's heading. */}
      <div key={`${route.area}/${route.screenId}`} className="screen">
        {screen.render({ route, navigate })}
      </div>
    </>
  )
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
