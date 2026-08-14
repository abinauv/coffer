import { describe, expect, it } from 'vitest'
import {
  createScreenRegistry,
  findScreen,
  isScreenDefinition,
  navSections,
  type ScreenDefinition,
} from './screens'

function screen(overrides: Partial<ScreenDefinition> & { id: string }): ScreenDefinition {
  return {
    title: overrides.id,
    area: 'workspace',
    render: () => null,
    ...overrides,
  }
}

describe('createScreenRegistry', () => {
  it('registers and unregisters', () => {
    const registry = createScreenRegistry()
    const remove = registry.register([screen({ id: 'ledger' })])
    expect(registry.list()).toHaveLength(1)
    remove()
    expect(registry.list()).toHaveLength(0)
  })

  /* Ids are unique within an area, not globally: a 'settings' screen may exist
   * both before and after a company is open. */
  it('keys screens by area and id, so the same id can exist in both areas', () => {
    const registry = createScreenRegistry()
    registry.register([
      screen({ id: 'settings', area: 'welcome' }),
      screen({ id: 'settings', area: 'workspace' }),
    ])
    expect(registry.list()).toHaveLength(2)
  })

  it('lets a later registration replace the same area and id', () => {
    const registry = createScreenRegistry()
    registry.register([screen({ id: 'ledger', title: 'Old' })])
    registry.register([screen({ id: 'ledger', title: 'New' })])
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.title).toBe('New')
  })

  it('keeps the snapshot stable between mutations', () => {
    const registry = createScreenRegistry()
    registry.register([screen({ id: 'ledger' })])
    expect(registry.list()).toBe(registry.list())
  })

  it('notifies subscribers', () => {
    const registry = createScreenRegistry()
    let calls = 0
    const unsubscribe = registry.subscribe(() => {
      calls += 1
    })
    registry.register([screen({ id: 'ledger' })])
    expect(calls).toBe(1)
    unsubscribe()
    registry.register([screen({ id: 'invoices' })])
    expect(calls).toBe(1)
  })
})

describe('findScreen', () => {
  const screens = [
    screen({ id: 'ledger' }),
    screen({ id: 'ledger', area: 'welcome' }),
    screen({ id: 'invoices' }),
  ]

  it('resolves within the given area only', () => {
    expect(findScreen(screens, 'workspace', 'ledger')?.area).toBe('workspace')
    expect(findScreen(screens, 'welcome', 'ledger')?.area).toBe('welcome')
    expect(findScreen(screens, 'welcome', 'invoices')).toBeUndefined()
  })

  it('is undefined for an unknown id', () => {
    expect(findScreen(screens, 'workspace', 'nope')).toBeUndefined()
  })
})

describe('navSections', () => {
  const screens = [
    screen({ id: 'overview', nav: { label: 'Overview', icon: 'ledger', group: 'work', order: 1 } }),
    screen({
      id: 'invoices',
      nav: { label: 'Invoices', icon: 'ledger', group: 'sales', order: 2 },
    }),
    screen({ id: 'quotes', nav: { label: 'Quotes', icon: 'ledger', group: 'sales', order: 1 } }),
    screen({ id: 'hidden' }),
    screen({
      id: 'picker',
      area: 'welcome',
      nav: { label: 'Companies', icon: 'folder', group: 'work', order: 1 },
    }),
  ]

  it('omits screens with no nav metadata', () => {
    const labels = navSections(screens, 'workspace').flatMap((section) =>
      section.screens.map((entry) => entry.id),
    )
    expect(labels).not.toContain('hidden')
  })

  it('omits screens from the other area', () => {
    const ids = navSections(screens, 'workspace').flatMap((section) =>
      section.screens.map((entry) => entry.id),
    )
    expect(ids).not.toContain('picker')
  })

  it('drops empty groups and keeps the declared group order', () => {
    expect(navSections(screens, 'workspace').map((section) => section.id)).toEqual([
      'work',
      'sales',
    ])
  })

  it('sorts within a group by order, then by label', () => {
    const sales = navSections(screens, 'workspace').find((section) => section.id === 'sales')
    expect(sales?.screens.map((entry) => entry.id)).toEqual(['quotes', 'invoices'])
  })

  it('breaks an order tie alphabetically', () => {
    const tied = [
      screen({ id: 'b', nav: { label: 'Bravo', icon: 'ledger', group: 'work', order: 1 } }),
      screen({ id: 'a', nav: { label: 'Alpha', icon: 'ledger', group: 'work', order: 1 } }),
    ]
    expect(navSections(tied, 'workspace')[0]?.screens.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('is empty when nothing is registered', () => {
    expect(navSections([], 'workspace')).toEqual([])
  })
})

describe('isScreenDefinition', () => {
  it('accepts a well-formed screen with and without nav', () => {
    expect(isScreenDefinition(screen({ id: 'ledger' }))).toBe(true)
    expect(
      isScreenDefinition(
        screen({
          id: 'ledger',
          nav: { label: 'Ledger', icon: 'ledger', group: 'accounts', order: 1 },
        }),
      ),
    ).toBe(true)
  })

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 'ledger', 42, []]) {
      expect(isScreenDefinition(value)).toBe(false)
    }
  })

  it('rejects a missing or empty id, title, area or renderer', () => {
    expect(isScreenDefinition({ title: 'x', area: 'workspace', render: () => null })).toBe(false)
    expect(isScreenDefinition({ id: '', title: 'x', area: 'workspace', render: () => null })).toBe(
      false,
    )
    expect(isScreenDefinition({ id: 'a', area: 'workspace', render: () => null })).toBe(false)
    expect(isScreenDefinition({ id: 'a', title: 'x', area: 'nope', render: () => null })).toBe(
      false,
    )
    expect(isScreenDefinition({ id: 'a', title: 'x', area: 'workspace' })).toBe(false)
  })

  it('rejects nav metadata naming a group that does not exist', () => {
    expect(
      isScreenDefinition({
        id: 'a',
        title: 'x',
        area: 'workspace',
        render: () => null,
        nav: { label: 'A', icon: 'ledger', group: 'nowhere', order: 1 },
      }),
    ).toBe(false)
  })

  it('rejects incomplete nav metadata', () => {
    expect(
      isScreenDefinition({
        id: 'a',
        title: 'x',
        area: 'workspace',
        render: () => null,
        nav: { label: 'A', icon: 'ledger', group: 'work' },
      }),
    ).toBe(false)
  })
})
