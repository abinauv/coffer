import { describe, expect, it } from 'vitest'
import { makeRoute } from './routing'
import { navSections, type ScreenDefinition } from './screens'
import { adjacentSection, landingScreen, railScreenFor, resolveSection } from './sections'

function screen(overrides: Partial<ScreenDefinition> & { id: string }): ScreenDefinition {
  return { title: overrides.id, area: 'workspace', render: () => null, ...overrides }
}

const SCREENS: readonly ScreenDefinition[] = [
  screen({ id: 'invoices', nav: { label: 'Invoices', icon: 'ledger', group: 'sales', order: 1 } }),
  screen({
    id: 'customers',
    nav: { label: 'Customers', icon: 'people', group: 'sales', order: 2 },
  }),
  screen({ id: 'invoice', navParent: 'invoices' }),
  screen({ id: 'bills', nav: { label: 'Bills', icon: 'ledger', group: 'purchases', order: 1 } }),
  screen({ id: 'ledger', nav: { label: 'Ledger', icon: 'ledger', group: 'accounts', order: 1 } }),
  screen({ id: 'parties' }),
  /* A parent that names a screen with no rail entry of its own. */
  screen({ id: 'orphan', navParent: 'parties' }),
  screen({ id: 'lost', navParent: 'nowhere' }),
]

const SECTIONS = navSections(SCREENS, 'workspace')

function at(screenId: string): ReturnType<typeof railScreenFor> {
  return railScreenFor(SCREENS, makeRoute('workspace', screenId))
}

describe('the rail entry a route belongs to', () => {
  it('is the screen itself when it is in the rail', () => {
    expect(at('customers')?.id).toBe('customers')
  })

  /* An editor has no rail entry, and the rail still has to say where you are. */
  it('is the register an editor was opened from', () => {
    expect(at('invoice')?.id).toBe('invoices')
    expect(at('invoice')?.nav.group).toBe('sales')
  })

  it('is nothing for a screen that belongs to no register', () => {
    expect(at('parties')).toBeNull()
  })

  /* Marking a screen that is not drawn marks nothing, so it is reported as nothing. */
  it('is nothing when the parent is not in the rail or does not exist', () => {
    expect(at('orphan')).toBeNull()
    expect(at('lost')).toBeNull()
  })

  it('is nothing for a route no screen answers', () => {
    expect(at('missing')).toBeNull()
  })

  it('looks only in the route’s own area', () => {
    expect(railScreenFor(SCREENS, makeRoute('welcome', 'customers'))).toBeNull()
  })
})

describe('the section to show', () => {
  it('is the route’s own when it has one, whatever was shown before', () => {
    expect(resolveSection(SECTIONS, 'purchases', 'sales')?.id).toBe('purchases')
  })

  /* Opening the list of every party from Purchases must not throw the rail over to Sales. */
  it('stays where it was when the route has none', () => {
    expect(resolveSection(SECTIONS, null, 'purchases')?.id).toBe('purchases')
  })

  it('falls back to the first before anything has been shown', () => {
    expect(resolveSection(SECTIONS, null, null)?.id).toBe('sales')
  })

  it('ignores a section that has no screens', () => {
    expect(resolveSection(SECTIONS, 'reports', null)?.id).toBe('sales')
  })

  it('is nothing when there are no sections', () => {
    expect(resolveSection([], 'sales', 'sales')).toBeNull()
  })
})

describe('the next and previous section', () => {
  it('steps in the order the section bar draws them', () => {
    expect(adjacentSection(SECTIONS, 'sales', 1)?.id).toBe('purchases')
    expect(adjacentSection(SECTIONS, 'purchases', -1)?.id).toBe('sales')
  })

  it('wraps round at both ends', () => {
    expect(adjacentSection(SECTIONS, 'accounts', 1)?.id).toBe('sales')
    expect(adjacentSection(SECTIONS, 'sales', -1)?.id).toBe('accounts')
  })

  /* Reports has no screens in this fixture, so it is not a section to step from. */
  it('starts from the first when the current one is not drawn', () => {
    expect(adjacentSection(SECTIONS, 'reports', 1)?.id).toBe('sales')
    expect(adjacentSection(SECTIONS, null, -1)?.id).toBe('sales')
  })

  it('is nothing when there are no sections', () => {
    expect(adjacentSection([], 'sales', 1)).toBeNull()
  })
})

describe('where choosing a section lands', () => {
  const sales = SECTIONS.find((section) => section.id === 'sales')
  if (sales === undefined) throw new Error('the fixture has a Sales section')

  it('is the screen last open in it', () => {
    expect(landingScreen(sales, 'customers')?.id).toBe('customers')
  })

  it('is the first screen when none was open', () => {
    expect(landingScreen(sales, undefined)?.id).toBe('invoices')
  })

  it('is the first screen when the one remembered has left the rail', () => {
    expect(landingScreen(sales, 'bills')?.id).toBe('invoices')
  })
})
