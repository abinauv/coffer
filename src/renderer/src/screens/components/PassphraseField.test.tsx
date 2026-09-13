/*
 * The passphrase field, rendered.
 *
 * THIS FIELD IS ON THE PATH WHERE A USER SETS THE ONE SECRET THAT PROTECTS THEIR BOOKS,
 * and the decision this file exists to defend is locked: STRENGTH WARNS, IT NEVER
 * BLOCKS (ARCHITECTURE §6.3.1, SECURITY.md). A user refused their own passphrase has
 * nobody to appeal to — there is no reset, no escrow and no maintainer key — so a weak
 * passphrase must still reach `onSubmit`. A test pinning "weak is refused" would be
 * enshrining the opposite of a deliberate decision, so the assertion below is the other
 * way round: it goes through.
 *
 * THE SECOND THING THIS FILE DEFENDS is that the warning is HEARD. The no-reset sentence
 * is the one fact that changes what a careful person does next, and putting it on screen
 * is not the same as attaching it to the field: it has to be the field's accessible
 * DESCRIPTION, and the label has to stay the field's NAME.
 *
 * AND THE THIRD: the value is written to exactly one place in the DOM. Not a title, not
 * a data attribute, not a stray span.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PassphraseStrength } from '@shared/dto'
import { NO_RESET_WARNING } from '../lib/passphrase-meter'
import { PassphraseField } from './PassphraseField'
import { StrengthMeter } from './StrengthMeter'

const HINT = 'Four unrelated words you will not forget beats one clever word you might.'

/** A passphrase nobody would call strong, and nothing here refuses. */
const WEAK = 'password1'

function weakStrength(): PassphraseStrength {
  return {
    score: 0,
    label: 'Very weak',
    suggestion: 'Add two more words. Length beats symbols.',
    isWeak: true,
  }
}

/** The field with a parent holding its value, as every real caller does. */
function Controlled({
  onSubmit,
  onChange,
  label = 'Passphrase',
}: {
  onSubmit?: () => void
  onChange?: (value: string) => void
  label?: string
}): JSX.Element {
  const [value, setValue] = useState('')
  return (
    <PassphraseField
      label={label}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      hint={HINT}
      onSubmit={onSubmit}
    />
  )
}

/** Every element carrying `secret` in an attribute. Should only ever be the input. */
function elementsCarrying(container: HTMLElement, secret: string): Element[] {
  return [...container.querySelectorAll('*')].filter((element) =>
    [...element.attributes].some((attribute) => attribute.value.includes(secret)),
  )
}

describe('PassphraseField', () => {
  it('is named by its label, and described by its hint', () => {
    render(<PassphraseField label="Passphrase" value="" onChange={() => {}} hint={HINT} />)

    const input = screen.getByLabelText('Passphrase')
    /* The name is the label alone. A hint folded into the name is read out on every
     * focus, ahead of anything the user is trying to hear. */
    expect(input).toHaveAccessibleName('Passphrase')
    expect(input).toHaveAccessibleDescription(HINT)
  })

  it('attaches the no-reset warning to the field, not merely to the page', () => {
    /* Losing this sentence loses the books. Rendering it somewhere on screen is not
     * enough — it has to be what this field is described BY, so it reaches somebody
     * who is tabbing rather than reading. */
    render(
      <PassphraseField label="Passphrase" value="" onChange={() => {}} hint={NO_RESET_WARNING} />,
    )

    expect(screen.getByLabelText('Passphrase')).toHaveAccessibleDescription(NO_RESET_WARNING)
    expect(screen.getByText(NO_RESET_WARNING)).toBeInTheDocument()
  })

  it('hides what was typed until asked, and shows it on request', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const input = screen.getByLabelText('Passphrase')

    /* Off by default. Someone reading a passphrase back to check a typo is not the
     * same as someone leaving it on screen behind them. */
    expect(input).toHaveAttribute('type', 'password')
    const reveal = screen.getByRole('button', { name: 'Show' })
    expect(reveal).toHaveAttribute('aria-pressed', 'false')

    await user.click(reveal)
    expect(input).toHaveAttribute('type', 'text')
    /* The button says the STATE, and the state changed with it. */
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Show' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('revealing changes nothing but the reveal', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Controlled onChange={onChange} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Passphrase'), WEAK)
    onChange.mockClear()

    await user.click(screen.getByRole('button', { name: 'Show' }))

    /* Not a submit, not an edit, and the value is still there. The reveal button sits
     * inside the field; a missing `type="button"` would have submitted the form. */
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Passphrase')).toHaveValue(WEAK)
  })

  it('writes the passphrase to the input and nowhere else', () => {
    const secret = 'correct-horse-battery-staple'
    const { container } = render(
      <PassphraseField label="Passphrase" value={secret} onChange={() => {}} hint={HINT} />,
    )

    /* React puts a controlled input's value in a `value` attribute as well as on the
     * node, so the input itself is expected here. Nothing else may be: a `title`, a
     * `data-` attribute or an `aria-label` holding a passphrase is a passphrase in the
     * accessibility tree, in a screenshot and in a bug report. */
    const carriers = elementsCarrying(container, secret)
    expect(carriers).toHaveLength(1)
    expect(carriers[0]).toBe(screen.getByLabelText('Passphrase'))
    /* And no text node renders it — the reveal is a type change, not a second copy. */
    expect(container.textContent).not.toContain(secret)
  })

  it('keeps the password manager, the spell checker and autocorrect out of it', () => {
    render(<PassphraseField label="Passphrase" value={WEAK} onChange={() => {}} />)

    const input = screen.getByLabelText('Passphrase')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('autocapitalize', 'off')
    /* A spell checker is a network service on some platforms. */
    expect(input).toHaveAttribute('spellcheck', 'false')
  })

  it('reports every keystroke to the screen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    await user.type(screen.getByLabelText('Passphrase'), 'four words')

    expect(onChange).toHaveBeenLastCalledWith('four words')
    expect(screen.getByLabelText('Passphrase')).toHaveValue('four words')
  })

  // ---- Weak warns, and never blocks -----------------------------------------

  it('lets a weak passphrase be submitted', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    /* The locked decision, asserted the way round it was decided. The field is shown
     * the worst verdict the meter can give — score 0, flagged weak — and still submits.
     * A test asserting the opposite would pin a bug that cannot be appealed. */
    render(
      <PassphraseField
        label="Passphrase"
        value={WEAK}
        onChange={() => {}}
        hint={HINT}
        onSubmit={onSubmit}
      >
        <StrengthMeter strength={weakStrength()} passphrase={WEAK} />
      </PassphraseField>,
    )

    const input = screen.getByLabelText('Passphrase')
    /* The warning is on screen at the same time. It warns AND it goes through — the
     * two halves of the decision, and either alone is the wrong product. */
    expect(screen.getByRole('meter', { name: 'Passphrase strength' })).toHaveAttribute(
      'aria-valuetext',
      'Very weak passphrase',
    )
    expect(screen.getByText('Very weak')).toBeInTheDocument()

    /* Nothing is disabled, and nothing is marked invalid: weakness is not an error. */
    expect(input).toBeEnabled()
    expect(input).not.toHaveAttribute('aria-invalid')

    await user.type(input, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits on Enter', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Controlled onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Passphrase'), `${WEAK}{Enter}`)

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does nothing on Enter when the screen offers no submit', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    /* Half of a compound guard: `event.key === 'Enter' && onSubmit`. This input is the
     * one Enter reaches with no handler behind it, and it must not throw. */
    render(<PassphraseField label="Passphrase" value={WEAK} onChange={onChange} hint={HINT} />)

    await user.type(screen.getByLabelText('Passphrase'), '{Enter}')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Passphrase')).toHaveValue(WEAK)
  })

  it('does not submit on a key that is not Enter', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    /* The other half. A guard reduced to `if (onSubmit)` submits on every keystroke,
     * which on the create screen means creating the company on the first letter. */
    render(<Controlled onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Passphrase'), 'a b{Escape}')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Passphrase')).toHaveValue('a b')
  })

  // ---- Errors ---------------------------------------------------------------

  it('replaces the hint with the error and announces it', () => {
    const message = 'These two do not match. Check both — nothing is stored to compare against.'
    render(
      <PassphraseField
        label="Passphrase again"
        value={WEAK}
        onChange={() => {}}
        hint={HINT}
        error={message}
      />,
    )

    const input = screen.getByLabelText('Passphrase again')
    /* `error ?? hint` — the error wins, and the field is described by the error rather
     * than by advice about a decision that has already gone wrong. */
    expect(input).toHaveAccessibleDescription(message)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(message)
  })

  it('does not interrupt for a hint the way it does for an error', () => {
    const { container } = render(
      <PassphraseField label="Passphrase" value="" onChange={() => {}} hint={HINT} />,
    )

    /* A standing hint is read on focus; only a validation failure interrupts. */
    expect(within(container).queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Passphrase')).not.toHaveAttribute('aria-invalid')
  })

  it('describes nothing when there is neither hint nor error', () => {
    render(<PassphraseField label="Passphrase" value="" onChange={() => {}} />)

    /* Not a dangling `aria-describedby` pointing at a paragraph that was never
     * rendered. */
    expect(screen.getByLabelText('Passphrase')).not.toHaveAttribute('aria-describedby')
  })

  // ---- The rest -------------------------------------------------------------

  it('disables the field and the reveal together', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PassphraseField label="Passphrase" value={WEAK} onChange={onChange} isDisabled />)

    const input = screen.getByLabelText('Passphrase')
    expect(input).toBeDisabled()
    /* A live reveal on a disabled field is a way to read a passphrase off a screen
     * that is busy submitting it. */
    expect(screen.getByRole('button', { name: 'Show' })).toBeDisabled()

    await user.type(input, 'more')
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('type', 'password')
  })

  it('renders the meter slot under the field', () => {
    render(
      <PassphraseField label="Passphrase" value={WEAK} onChange={() => {}} hint={HINT}>
        <StrengthMeter strength={weakStrength()} passphrase={WEAK} />
      </PassphraseField>,
    )

    /* The meter belongs to the field, so it lives inside it — a meter elsewhere on the
     * page is a verdict with no visible subject. */
    const field = screen.getByLabelText('Passphrase').closest('.passphrase-field')
    expect(field).not.toBeNull()
    expect(
      within(field as HTMLElement).getByRole('meter', { name: 'Passphrase strength' }),
    ).toBeInTheDocument()
  })

  it('takes focus when the screen asks it to', () => {
    render(<PassphraseField label="Passphrase" value="" onChange={() => {}} autoFocus />)

    expect(screen.getByLabelText('Passphrase')).toHaveFocus()
  })

  it('keeps two fields on one screen apart', async () => {
    const user = userEvent.setup()

    /* The create screen has exactly this pair, and the whole point of the second one
     * is that a typo in the first is unrecoverable. Shared ids would put both labels
     * on one input and the confirmation would compare a value with itself. */
    render(
      <>
        <Controlled label="Passphrase" />
        <Controlled label="Passphrase again" />
      </>,
    )

    await user.type(screen.getByLabelText('Passphrase'), 'first')
    await user.type(screen.getByLabelText('Passphrase again'), 'second')

    expect(screen.getByLabelText('Passphrase')).toHaveValue('first')
    expect(screen.getByLabelText('Passphrase again')).toHaveValue('second')
  })

  it('reveals one field without revealing the other', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Controlled label="Passphrase" />
        <Controlled label="Passphrase again" />
      </>,
    )

    /* Reveal is per field, held in that field's own state. */
    const reveals = screen.getAllByRole('button', { name: 'Show' })
    await user.click(reveals[1] as HTMLElement)

    expect(screen.getByLabelText('Passphrase')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Passphrase again')).toHaveAttribute('type', 'text')
  })
})
