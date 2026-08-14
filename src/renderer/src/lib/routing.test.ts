import { describe, expect, it } from 'vitest'
import {
  areaForCompany,
  canGoBack,
  currentRoute,
  goBack,
  homeRoute,
  isSameRoute,
  makeRoute,
  navigate,
  routeForCompany,
  type Route,
} from './routing'

describe('areaForCompany', () => {
  it('maps an open company to the workspace and none to the welcome area', () => {
    expect(areaForCompany(true)).toBe('workspace')
    expect(areaForCompany(false)).toBe('welcome')
  })
})

describe('homeRoute', () => {
  it('gives each area a landing screen with no parameters', () => {
    expect(homeRoute('welcome')).toEqual({ area: 'welcome', screenId: 'companies', params: {} })
    expect(homeRoute('workspace')).toEqual({ area: 'workspace', screenId: 'overview', params: {} })
  })
})

describe('isSameRoute', () => {
  it('compares area, screen and parameters', () => {
    const base = makeRoute('workspace', 'ledger', { account: '1001' })
    expect(isSameRoute(base, makeRoute('workspace', 'ledger', { account: '1001' }))).toBe(true)
    expect(isSameRoute(base, makeRoute('workspace', 'ledger', { account: '2001' }))).toBe(false)
    expect(isSameRoute(base, makeRoute('workspace', 'invoices', { account: '1001' }))).toBe(false)
    expect(isSameRoute(base, makeRoute('welcome', 'ledger', { account: '1001' }))).toBe(false)
  })

  it('treats a missing parameter as different from an extra one', () => {
    expect(isSameRoute(makeRoute('workspace', 'a'), makeRoute('workspace', 'a', { x: '1' }))).toBe(
      false,
    )
  })
})

describe('navigate', () => {
  it('pushes onto the stack', () => {
    const history = navigate([homeRoute('workspace')], makeRoute('workspace', 'invoices'))
    expect(history).toHaveLength(2)
    expect(currentRoute(history).screenId).toBe('invoices')
  })

  /* Clicking the active nav item twice must not make Back a no-op. */
  it('ignores a push to the route already showing', () => {
    const history = [homeRoute('workspace')]
    expect(navigate(history, homeRoute('workspace'))).toBe(history)
  })

  it('replaces the top entry in replace mode', () => {
    let history = navigate([homeRoute('workspace')], makeRoute('workspace', 'invoices'))
    history = navigate(history, makeRoute('workspace', 'bills'), 'replace')
    expect(history).toHaveLength(2)
    expect(currentRoute(history).screenId).toBe('bills')
  })

  it('replaces even when the target equals the current route', () => {
    const history = [homeRoute('workspace')]
    const replaced = navigate(history, homeRoute('workspace'), 'replace')
    expect(replaced).toHaveLength(1)
  })

  it('caps the stack rather than growing without bound', () => {
    let history: readonly Route[] = [homeRoute('workspace')]
    for (let index = 0; index < 120; index += 1) {
      history = navigate(history, makeRoute('workspace', `screen-${index}`))
    }
    expect(history.length).toBeLessThanOrEqual(50)
    expect(currentRoute(history).screenId).toBe('screen-119')
  })
})

describe('goBack', () => {
  it('pops the top entry', () => {
    const history = navigate([homeRoute('workspace')], makeRoute('workspace', 'invoices'))
    expect(currentRoute(goBack(history)).screenId).toBe('overview')
  })

  it('will not empty the stack', () => {
    const history = [homeRoute('workspace')]
    expect(goBack(history)).toBe(history)
    expect(canGoBack(history)).toBe(false)
  })
})

describe('currentRoute', () => {
  it('falls back to the welcome home for an empty stack', () => {
    expect(currentRoute([])).toEqual(homeRoute('welcome'))
  })
})

describe('routeForCompany', () => {
  it('leaves the stack alone while the area is unchanged', () => {
    const history = navigate([homeRoute('workspace')], makeRoute('workspace', 'invoices'))
    expect(routeForCompany(history, true)).toBe(history)
  })

  /* Closing a company must not leave a ledger screen one Back press away. */
  it('resets to the welcome home when the company closes', () => {
    const history = navigate([homeRoute('workspace')], makeRoute('workspace', 'invoices'))
    expect(routeForCompany(history, false)).toEqual([homeRoute('welcome')])
  })

  it('resets to the workspace home when a company opens', () => {
    const history = navigate([homeRoute('welcome')], makeRoute('welcome', 'create'))
    expect(routeForCompany(history, true)).toEqual([homeRoute('workspace')])
  })

  it('produces a valid stack from an empty one', () => {
    expect(routeForCompany([], false)).toEqual([homeRoute('welcome')])
    expect(routeForCompany([], true)).toEqual([homeRoute('workspace')])
  })
})
