/*
 * A failure on the screen it happened on.
 *
 * `describeFailure` and `failureDetail` are covered as pure functions in
 * ../lib/messages.test.ts. What is covered only here is the wiring between them and the
 * box: that the CONTEXT this screen passes actually reaches the table, that a button
 * appears only when this screen can honour the offer behind it, and that a malformed
 * error still renders something a person can act on.
 *
 * THE COPY IS ASSERTED BY VALUE, not by "some text was rendered". A failure notice that
 * renders the wrong sentence is worse than one that renders none: it sends the user to
 * restore a backup when the fix was to reconnect a drive.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppError } from '@shared/dto'
import { describeFailure } from '../lib/messages'
import { FailureNotice } from './FailureNotice'

function error(code: string, message = ''): AppError {
  return { code, message }
}

function detailIn(container: HTMLElement): Element | null {
  return container.querySelector('.notice__detail')
}

describe('FailureNotice', () => {
  it('prints the title and the body for the code that arrived', () => {
    render(<FailureNotice error={error('PASSPHRASE_INVALID', 'Wrong passphrase.')} />)

    expect(screen.getByText('That passphrase does not open this company.')).toBeInTheDocument()
    expect(screen.getByText(/this one is stored nowhere/)).toBeInTheDocument()
  })

  it('interrupts, because a failure is not a standing note', () => {
    const { container } = render(<FailureNotice error={error('NO_COMPANY_OPEN')} />)

    /* Danger tone, so `role="alert"`. A failure the user has to be told about arriving
     * silently under the fold is the whole reason this component exists. */
    expect(within(container).getByRole('alert')).toHaveTextContent('No company is open.')
  })

  it('says something different on the screen that asked', () => {
    /* The same code, three contexts, three sentences — and the general one is not
     * either of the special ones. A component that dropped `context` on the floor would
     * render the general copy three times and only a by-value comparison sees it. */
    const missing = error('PASSPHRASE_REQUIRED')

    const general = render(<FailureNotice error={missing} />)
    expect(screen.getByText('Enter a passphrase.')).toBeInTheDocument()
    general.unmount()

    const unlock = render(<FailureNotice error={missing} context="unlock" />)
    expect(screen.getByText('Enter your passphrase.')).toBeInTheDocument()
    unlock.unmount()

    render(<FailureNotice error={missing} context="recover" />)
    expect(screen.getByText('Choose the passphrase you will use from now on.')).toBeInTheDocument()
  })

  it('is a general failure when no context is given', () => {
    /* The default matters: every ledger screen renders this with no context, and the
     * override tables must not leak into them. Both sentences are asserted as PRESENT,
     * one on each render — "the override did not appear" would keep passing if the
     * override were deleted, renamed, or never reached. */
    const wrong = error('PASSPHRASE_INVALID')

    const general = render(<FailureNotice error={wrong} />)
    expect(screen.getByText('That passphrase does not open this company.')).toBeInTheDocument()
    general.unmount()

    render(<FailureNotice error={wrong} context="change-passphrase" />)
    expect(
      screen.getByText('That is not the current passphrase for this company.'),
    ).toBeInTheDocument()
  })

  // ---- The offer ------------------------------------------------------------

  it('offers the one action the failure has, and calls it', async () => {
    const user = userEvent.setup()
    const recover = vi.fn()
    render(
      <FailureNotice error={error('PASSPHRASE_INVALID')} context="unlock" onAction={{ recover }} />,
    )

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }))

    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('names the offer by what it does, not by its code', () => {
    /* Four codes with four different actions, so the label table is exercised past its
     * first row. A `Record` keyed on the action reads the same as an if-chain until the
     * second entry is checked. */
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['PASSPHRASE_INVALID', 'Use a recovery code'],
      ['COMPANY_NOT_FOUND', 'Find the file'],
      ['DB_CORRUPT', 'Restore from a backup'],
      ['PATH_NOT_FOUND', 'Check again'],
    ]

    for (const [code, label] of cases) {
      const { unmount } = render(
        <FailureNotice
          error={error(code)}
          onAction={{
            recover: () => {},
            'add-existing': () => {},
            restore: () => {},
            refresh: () => {},
          }}
        />,
      )
      expect(screen.getByRole('button', { name: label }), code).toBeInTheDocument()
      unmount()
    }
  })

  it('offers nothing when this screen cannot honour the offer it has', () => {
    /* The failure asks for `recover`; this screen can only `restore`. Better no button
     * than one that goes nowhere — and specifically not the restore button, which would
     * send the user to overwrite their books to fix a typed passphrase. */
    const { container } = render(
      <FailureNotice error={error('PASSPHRASE_INVALID')} onAction={{ restore: () => {} }} />,
    )

    expect(screen.getByText('That passphrase does not open this company.')).toBeInTheDocument()
    expect(within(container).queryByRole('button')).toBeNull()
  })

  it('offers nothing when the screen passed no handlers at all', () => {
    const { container } = render(<FailureNotice error={error('PASSPHRASE_INVALID')} />)

    expect(within(container).queryByRole('button')).toBeNull()
  })

  it('offers nothing when the failure itself has no useful next step', () => {
    /* The other half of the guard, and the one a handler map alone cannot exclude:
     * this code's guidance has no action, so every handler the screen offers is
     * irrelevant to it. */
    const { container } = render(
      <FailureNotice
        error={error('PASSPHRASE_EMPTY')}
        onAction={{
          recover: () => {},
          'add-existing': () => {},
          restore: () => {},
          refresh: () => {},
        }}
      />,
    )

    expect(screen.getByText('Enter your passphrase.')).toBeInTheDocument()
    expect(within(container).queryByRole('button')).toBeNull()
  })

  // ---- The detail line ------------------------------------------------------

  it("prints main's own message where it names the file", () => {
    const path = 'D:\\Books\\Kaveri Traders.coffer'
    const { container } = render(
      <FailureNotice error={error('COMPANY_DATABASE_MISSING', `Cannot find ${path}.`)} />,
    )

    /* The detail is the only part of a failure this renderer cannot write for itself,
     * and it is what makes "point Coffer at it again" possible. */
    expect(detailIn(container)).toHaveTextContent(path)
  })

  it("keeps main's message off screen where it adds nothing", () => {
    const { container } = render(
      <FailureNotice error={error('PASSPHRASE_INVALID', 'Argon2 verification returned false.')} />,
    )

    /* This code's copy is complete on its own, and main's wording here is written for
     * a log. No stack traces in the UI (CONVENTIONS §5). */
    expect(detailIn(container)).toBeNull()
  })

  it('does not repeat the body back at the reader as a detail', () => {
    /* A file-naming code whose message happens to be exactly the body — reached when
     * main sends the generic sentence for a code this table already answers. The
     * fixture is built from the guidance so it agrees with it on purpose: this is the
     * one place agreement is the condition under test. */
    const guidance = describeFailure(error('COMPANY_IO_FAILED'))
    const { container } = render(
      <FailureNotice error={error('COMPANY_IO_FAILED', guidance.body)} />,
    )

    expect(screen.getByText(guidance.body)).toBeInTheDocument()
    expect(detailIn(container)).toBeNull()
  })

  it('prints no detail when a file-naming failure arrives with no message', () => {
    const { container } = render(<FailureNotice error={error('COMPANY_VAULT_MISSING', '')} />)

    expect(screen.getByText("This company's keys are missing.")).toBeInTheDocument()
    expect(detailIn(container)).toBeNull()
  })

  // ---- Errors the table has never seen --------------------------------------

  it('shows what main said when the code is one nobody has written copy for', () => {
    render(
      <FailureNotice
        error={error('PERIOD_LOCKED_BY_AUDIT', 'That period is locked. Reopen it first.')}
      />,
    )

    expect(screen.getByText('Coffer could not finish that action.')).toBeInTheDocument()
    /* Main's own message rather than an apology — it is already written for a person. */
    expect(screen.getByText('That period is locked. Reopen it first.')).toBeInTheDocument()
  })

  it('still says what to do when an unknown code arrives with no message at all', () => {
    render(<FailureNotice error={error('PERIOD_LOCKED_BY_AUDIT', '')} />)

    expect(screen.getByText('Coffer could not finish that action.')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument()
  })

  it('treats a message of nothing but spaces as no message', () => {
    /* The state a `catch` block reaches when it stringifies an empty rejection. An
     * error box whose body is three spaces is a box that says nothing. */
    render(<FailureNotice error={error('PERIOD_LOCKED_BY_AUDIT', '   \n  ')} />)

    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument()
  })

  it('renders a message far longer than the box without cutting it', () => {
    const long = `Migration 0014 failed: ${'constraint check failed on journal_lines; '.repeat(30)}`
    expect(long.length).toBeGreaterThan(1000)

    render(<FailureNotice error={error('PERIOD_LOCKED_BY_AUDIT', long)} />)

    expect(screen.getByText(long.trim())).toBeInTheDocument()
  })
})
