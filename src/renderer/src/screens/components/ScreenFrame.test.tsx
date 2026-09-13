/*
 * The frame every company screen sits in.
 *
 * Nothing in the product renders a page without this, so the things worth pinning are
 * the ones a screen assumes rather than checks: that the title is a level-one heading
 * and not a styled paragraph, that the actions land in the head and the children in the
 * body, and that the optional parts are genuinely optional.
 *
 * AND ONE THING IT DOES THAT IT SHOULD NOT. `ScreenFrame` renders `TitleBarSync`, and
 * its own comment says why: the natural home is the shell, beside the ThemeProvider that
 * owns the decision, and this batch did not own those files. The last test in this file
 * pins WHAT IT DOES TODAY — colours crossing the bridge on mount — precisely so that
 * moving the effect upstairs is a visible change with a test to update, rather than a
 * three-line edit that silently stops repainting the window buttons.
 */

import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@renderer/components/atoms'
import { renderScreen } from '../../test/harness'
import { ScreenFrame } from './ScreenFrame'

function frameOf(container: HTMLElement): HTMLElement {
  const page = container.querySelector('.page')
  if (!(page instanceof HTMLElement)) throw new Error('No page was rendered')
  return page
}

/** Lets the effect's `requestAnimationFrame` run, and its promise settle. */
async function afterNextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  })
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('ScreenFrame', () => {
  it('puts the title in the one level-one heading on the page', () => {
    renderScreen(
      <ScreenFrame title="Create a company">
        <p>The body.</p>
      </ScreenFrame>,
    )

    /* A heading, not a paragraph in heading clothing: the whole document outline —
     * and every screen reader's "jump to heading" — hangs off this one element. */
    expect(screen.getByRole('heading', { level: 1, name: 'Create a company' })).toBeInTheDocument()
  })

  it('renders the lede under the title', () => {
    const lede = 'Coffer writes two files: the encrypted database, and the vault holding its keys.'
    renderScreen(
      <ScreenFrame title="Create a company" lede={lede}>
        <p>The body.</p>
      </ScreenFrame>,
    )

    expect(screen.getByText(lede)).toBeInTheDocument()
  })

  it('takes a lede that is markup rather than a sentence', () => {
    /* `lede` is a ReactNode, and the register screens hand it a node with a link in it.
     * A component that rendered it as text would print `[object Object]`. */
    renderScreen(
      <ScreenFrame
        title="Aged receivables"
        lede={
          <>
            As at <strong>30 June 2031</strong>
          </>
        }
      >
        <p>The body.</p>
      </ScreenFrame>,
    )

    expect(screen.getByText('30 June 2031')).toBeInTheDocument()
  })

  it('leaves the lede out when the screen has nothing to say', () => {
    const { container } = renderScreen(
      <ScreenFrame title="Chart of accounts">
        <p>The body.</p>
      </ScreenFrame>,
    )

    /* Not an empty paragraph. The heading and the body would otherwise be pushed apart
     * by a line of nothing on every screen that does not use one. */
    expect(container.querySelector('.page__lede')).toBeNull()
  })

  it('keeps the screen actions out of the body', () => {
    const { container } = renderScreen(
      <ScreenFrame title="Chart of accounts" actions={<Button>New account</Button>}>
        <Button>Add a line</Button>
      </ScreenFrame>,
    )

    const head = container.querySelector('.page__actions')
    const body = container.querySelector('.page__body')

    /* Scoped to each slot rather than to the page. Both buttons exist either way; what
     * is under test is WHICH SLOT each landed in, and a page-wide query cannot see the
     * difference between an action in the header and one that fell into the form. */
    expect(
      within(head as HTMLElement).getByRole('button', { name: 'New account' }),
    ).toBeInTheDocument()
    expect(
      within(body as HTMLElement).getByRole('button', { name: 'Add a line' }),
    ).toBeInTheDocument()
    expect(within(head as HTMLElement).queryByRole('button', { name: 'Add a line' })).toBeNull()
  })

  it('leaves the actions row out when the screen has no actions', () => {
    const { container } = renderScreen(
      <ScreenFrame title="Chart of accounts">
        <p>The body.</p>
      </ScreenFrame>,
    )

    expect(container.querySelector('.page__actions')).toBeNull()
  })

  it('renders the children in the body', () => {
    const { container } = renderScreen(
      <ScreenFrame title="Trial balance">
        <table>
          <tbody>
            <tr>
              <td>1210 · Bank</td>
            </tr>
          </tbody>
        </table>
      </ScreenFrame>,
    )

    const body = container.querySelector('.page__body')
    expect(within(body as HTMLElement).getByRole('table')).toBeInTheDocument()
  })

  it('offers a way back, and calls it', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderScreen(
      <ScreenFrame title="Create a company" back={{ label: 'All companies', onClick }}>
        <p>The body.</p>
      </ScreenFrame>,
    )

    await user.click(screen.getByRole('button', { name: 'All companies' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('offers no way back from a screen that was not reached from another', () => {
    const { container } = renderScreen(
      <ScreenFrame title="Overview">
        <p>The body.</p>
      </ScreenFrame>,
    )

    /* A back button on the first screen of the workspace goes nowhere, which is worse
     * than not offering one. Scoped to the page, so the toast layer the harness mounts
     * beside it cannot answer for it. */
    expect(within(frameOf(container)).queryByRole('button')).toBeNull()
  })

  it('is a reading column unless the screen asks to be wider', () => {
    const narrow = renderScreen(
      <ScreenFrame title="Create a company">
        <p>The body.</p>
      </ScreenFrame>,
    )
    /* Both, in one test: the default is only meaningful next to the alternative it is
     * a default instead of. */
    expect(frameOf(narrow.container).className).toContain('page--form')
    expect(frameOf(narrow.container).className).not.toContain('page--list')
    narrow.unmount()

    const wide = renderScreen(
      <ScreenFrame title="Documents" width="list">
        <p>The body.</p>
      </ScreenFrame>,
    )
    expect(frameOf(wide.container).className).toContain('page--list')
    expect(frameOf(wide.container).className).not.toContain('page--form')
  })

  it('adds its own padding only where the surroundings supply none', () => {
    const plain = renderScreen(
      <ScreenFrame title="Chart of accounts">
        <p>The body.</p>
      </ScreenFrame>,
    )
    expect(frameOf(plain.container).className).not.toContain('page--inset')
    plain.unmount()

    /* The welcome canvas centres and pads its own content; `.app__main` does not. */
    const inset = renderScreen(
      <ScreenFrame title="Create a company" isInset>
        <p>The body.</p>
      </ScreenFrame>,
    )
    expect(frameOf(inset.container).className).toContain('page--inset')
  })

  // ---- The effect that should not be here ----------------------------------

  it('repaints the window buttons today, because TitleBarSync rides along in here', async () => {
    /* Asserted at the BOUNDARY: what crossed the bridge, not what was drawn. Nothing
     * about the title bar is visible in this document — the buttons are painted by the
     * OS — so the call is the only observable effect there is.
     *
     * The tokens are put on the document because no stylesheet is loaded in a test;
     * without them `overlayColorsFrom` reads nothing and correctly sends nothing.
     *
     * This pins CURRENT behaviour. The effect belongs in the shell beside the
     * ThemeProvider (see the note in TitleBarSync.tsx); when it moves, this test should
     * move with it rather than quietly stop meaning anything. */
    document.documentElement.style.setProperty('--chrome', '#1b2027')
    document.documentElement.style.setProperty('--ink-muted', '#8d97a4')

    const { bridge } = renderScreen(
      <ScreenFrame title="Overview">
        <p>The body.</p>
      </ScreenFrame>,
    )
    await afterNextFrame()

    expect(bridge.lastCallTo('system:setTitleBarOverlay')?.args[0]).toEqual({
      color: '#1b2027',
      symbolColor: '#8d97a4',
    })
  })
})
