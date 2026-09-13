/*
 * The notice box, rendered.
 *
 * This is one of the two components in the product whose job is to be right when
 * everything else has gone wrong, so it is tested against the states a caller reaches
 * only on a bad day: no title, an empty detail, a message longer than the box.
 *
 * TWO CLAIMS ARE LOAD-BEARING AND BOTH ARE ASSERTED BY VALUE.
 *
 *   - TONE IS NEVER THE ONLY SIGNAL. Every tone has its own icon and the icon is
 *     `aria-hidden`, so the words are what actually carry the meaning. The icon is
 *     checked against `ICON_PATHS` rather than against a literal `d` attribute: the
 *     claim is "the warning uses the alert triangle", and a test holding its own copy
 *     of the path would pass after the triangle was redrawn as a circle.
 *
 *   - ONLY A FAILURE INTERRUPTS. `role="alert"` moves a screen reader off whatever it
 *     was reading. A standing warning that did that would be unusable on the create
 *     screen, where the no-reset warning is on screen the whole time.
 */

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from '@renderer/components/atoms'
import { ICON_PATHS } from '@renderer/lib/icons'
import { Notice, type NoticeTone } from './Notice'

/** The icon actually drawn, by its path — the one thing that identifies which it is. */
function iconPathIn(container: HTMLElement): string | null {
  const path = container.querySelector('.notice__icon path')
  return path === null ? null : path.getAttribute('d')
}

function detailIn(container: HTMLElement): Element | null {
  return container.querySelector('.notice__detail')
}

describe('Notice', () => {
  it('gives each tone its own icon', () => {
    /* All four in one test, because the claim is that they DIFFER. Any one of them
     * checked alone passes against a component that draws the same glyph every time. */
    const expected: Record<NoticeTone, keyof typeof ICON_PATHS> = {
      info: 'info',
      warning: 'alert-triangle',
      danger: 'alert-circle',
      positive: 'check-circle',
    }

    for (const [tone, icon] of Object.entries(expected)) {
      const { container, unmount } = render(
        <Notice tone={tone as NoticeTone} title="Something to read" />,
      )
      expect(iconPathIn(container), tone).toBe(ICON_PATHS[icon])
      unmount()
    }

    /* And that they are four different glyphs, not four names for one. */
    const drawn = Object.values(expected).map((icon) => ICON_PATHS[icon])
    expect(new Set(drawn).size).toBe(4)
  })

  it('is an info notice when no tone is given', () => {
    const { container } = render(<Notice title="Where the files went" />)

    expect(iconPathIn(container)).toBe(ICON_PATHS.info)
    expect(container.querySelector('.notice')?.className).toContain('notice--info')
  })

  it('interrupts for a failure and not for a warning', () => {
    /*
     * Every tone, driven off a total record rather than a hand-written list: the
     * component decides this with a `Record<NoticeTone, …>` (CONVENTIONS §1.9), and a
     * fifth tone must not be able to reach the product without a test saying whether it
     * interrupts. Declared as a Record here for the same reason — adding a member to
     * the union stops this file compiling until it is answered for.
     */
    const expected: Record<NoticeTone, 'alert' | undefined> = {
      info: undefined,
      warning: undefined,
      danger: 'alert',
      positive: undefined,
    }

    for (const [tone, role] of Object.entries(expected)) {
      const { container, unmount } = render(
        <Notice tone={tone as NoticeTone} title="Standing advice" />,
      )
      if (role === undefined) {
        /* A warning about something that cannot be undone stays on screen for as long
         * as the user is reading the form around it; announcing it over the top of
         * every field would make the form unusable. */
        expect(within(container).queryByRole('alert'), tone).toBeNull()
      } else {
        /* By its words, not merely by its presence: a role on the wrong element
         * announces the box and not the sentence in it. */
        expect(within(container).getByRole('alert'), tone).toHaveTextContent('Standing advice')
      }
      unmount()
    }

    /* And that the two answers differ. A component returning one role for every tone
     * satisfies whichever half of the loop is checked on its own. */
    expect(new Set(Object.values(expected)).size).toBe(2)
  })

  it('keeps the icon and the interruption independent', () => {
    /* A caller may override the glyph on a failure — the shape is presentation. What it
     * must not do is quieten the alert: the role comes from the tone. Asserted together
     * because a component that derived one from the other would pass either alone. */
    const { container } = render(
      <Notice tone="danger" icon="folder" title="That folder is not where it was" />,
    )

    expect(iconPathIn(container)).toBe(ICON_PATHS.folder)
    expect(within(container).getByRole('alert')).toBeInTheDocument()
  })

  it('hides the icon from the accessibility tree and says the tone in words', () => {
    const { container } = render(
      <Notice tone="warning" title="This passphrase cannot be reset">
        <p>There is no way back into these books without it.</p>
      </Notice>,
    )

    /* Monochrome, or read aloud: either way the title is the message. The icon is
     * decoration beside it and must not be announced as a second thing. */
    expect(container.querySelector('.notice__icon')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('This passphrase cannot be reset')).toBeInTheDocument()
  })

  it('renders the body it was handed', () => {
    render(
      <Notice tone="info" title="Recovery codes">
        <p>Five codes, shown once.</p>
        <p>Each works exactly once.</p>
      </Notice>,
    )

    expect(screen.getByText('Five codes, shown once.')).toBeInTheDocument()
    expect(screen.getByText('Each works exactly once.')).toBeInTheDocument()
  })

  it('draws a notice with no title at all', () => {
    /* A body-only notice is a shape callers use, and the title is optional in the
     * props. Handed the state directly rather than trusting that nobody reaches it. */
    const { container } = render(
      <Notice tone="info">
        <p>Nothing has been posted here yet.</p>
      </Notice>,
    )

    expect(container.querySelector('.notice__title')).toBeNull()
    expect(screen.getByText('Nothing has been posted here yet.')).toBeInTheDocument()
    expect(iconPathIn(container)).toBe(ICON_PATHS.info)
  })

  it('draws a notice with nothing in it at all rather than throwing', () => {
    /* The worst state a caller can reach: every optional prop absent. An error box that
     * breaks on a malformed error takes the screen down with it. */
    const { container } = render(<Notice tone="danger" />)

    expect(within(container).getByRole('alert')).toBeInTheDocument()
    expect(iconPathIn(container)).toBe(ICON_PATHS['alert-circle'])
  })

  it('prints a detail under the body', () => {
    const path = 'D:\\Books\\Kaveri Traders.coffer'
    const { container } = render(
      <Notice tone="danger" title="Coffer cannot find this file" detail={path}>
        <p>Connect the drive and try again.</p>
      </Notice>,
    )

    const detail = detailIn(container)
    expect(detail).toHaveTextContent(path)
    /* The one thing a user will want to copy out of a failure. */
    expect(detail?.className).toContain('selectable')
  })

  it('prints no detail for any of the three ways of not having one', () => {
    /* Three conditions guard this, and each excludes an input the other two let
     * through: a caller that omits the prop sends `undefined`, `failureDetail` — the
     * only caller that computes one — returns `null`, and a caller that trims a path
     * down to nothing sends `''`. Deleting any one check puts an empty paragraph under
     * every notice in the product that arrives by that route. */
    const omitted = render(<Notice tone="warning" title="Nothing to add" />)
    expect(detailIn(omitted.container)).toBeNull()
    omitted.unmount()

    const explicitlyNone = render(<Notice tone="warning" title="Nothing to add" detail={null} />)
    expect(detailIn(explicitlyNone.container)).toBeNull()
    explicitlyNone.unmount()

    /* The empty string is not a detail. An empty `<p>` is a gap under the body that
     * reads as a sentence somebody forgot to write. */
    const empty = render(<Notice tone="warning" title="Nothing to add" detail="" />)
    expect(detailIn(empty.container)).toBeNull()
  })

  it('shows a message longer than the box in full, rather than cutting it', () => {
    /* Main's messages name paths, and a path is exactly the part that gets truncated.
     * 900 characters: past any sane single line, and nothing here shortens it. */
    const long = `The file at ${'\\very-long-folder-name'.repeat(40)}\\books.coffer could not be read.`
    expect(long.length).toBeGreaterThan(900)

    const { container } = render(
      <Notice tone="danger" title="Coffer could not read that file" detail={long}>
        <p>Check the drive is connected.</p>
      </Notice>,
    )

    expect(detailIn(container)).toHaveTextContent(long)
  })

  it('renders the actions it was given, under the body', () => {
    const { container } = render(
      <Notice
        tone="danger"
        title="That passphrase does not fit"
        actions={<Button size="sm">Use a recovery code</Button>}
      >
        <p>Unlock with a recovery code instead.</p>
      </Notice>,
    )

    const actions = container.querySelector('.notice__actions')
    expect(actions).not.toBeNull()
    /* Scoped to the actions slot, not to the notice: a button rendered into the body
     * would satisfy a search of the whole box and sit in the wrong place. */
    expect(
      within(actions as HTMLElement).getByRole('button', { name: 'Use a recovery code' }),
    ).toBeInTheDocument()
  })

  it('leaves out the actions row when there is nothing to offer', () => {
    /* Better no button than one that goes nowhere — and better no empty row than a
     * gap under every notice that has no way out. */
    const { container } = render(<Notice tone="danger" title="Coffer could not finish that" />)

    expect(container.querySelector('.notice__actions')).toBeNull()
  })
})
