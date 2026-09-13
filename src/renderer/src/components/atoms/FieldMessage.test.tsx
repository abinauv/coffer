/*
 * The field message atom, asserted from both ends at once.
 *
 * THE POINT OF EVERY TEST HERE IS THAT IT READS THE ATTRIBUTE AND THEN GOES AND LOOKS FOR
 * THE ELEMENT IT NAMES. An assertion on `aria-describedby` alone cannot tell a working
 * description from a dangling one: `aria-describedby="x-message"` pointing at nothing
 * looks perfect in the DOM, perfect in a screenshot, and announces an EMPTY description
 * — which is worse than no description, because an empty one is still an answer. That is
 * the bug `Dialog` shipped with its `aria-labelledby` until 0016 and the one
 * `CommandPalette` warns about beside its `aria-controls`, and it is the whole reason
 * this atom exists.
 *
 * So `describedElement()` below resolves the reference the way a screen reader would,
 * and every test asserts BOTH halves — the id that came back, and the element carrying
 * it — including the tests where the answer is "neither".
 */

import { render, screen } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { useFieldMessage, type FieldMessage } from './FieldMessage'

const FIELD_ID = 'legal-name'
const HINT = 'As it appears on the certificate of incorporation.'
const ERROR = 'Enter the name on the incorporation certificate.'

/*
 * The precedence pair, chosen so the ERROR IS A SUBSTRING OF THE HINT. `toHaveTextContent`
 * matches substrings, so a component that wrongly kept showing the hint would still
 * satisfy `toHaveTextContent(PRECEDENCE_ERROR)`. Every assertion below compares
 * `textContent` entire instead, and this pair is what makes that difference visible.
 */
const PRECEDENCE_ERROR = 'Choose a state.'
const PRECEDENCE_HINT = 'Choose a state. The place of supply decides which tax applies.'

interface FieldProps {
  id?: string
  label?: string
  hint?: ReactNode
  error?: string
  className?: string
}

/** What the hook returned on the most recent render of `Field`. */
let captured: FieldMessage | undefined

/**
 * A field wired the way the five real callers wire theirs: the control takes the two
 * attribute values, and the element goes beside it — never inside the label.
 */
function Field({
  id = FIELD_ID,
  label = 'Legal name',
  hint,
  error,
  className,
}: FieldProps): JSX.Element {
  const result = useFieldMessage({ id, hint, error, className })
  captured = result

  return (
    <>
      <input
        id={id}
        aria-label={label}
        aria-describedby={result.describedBy}
        aria-invalid={result.invalid}
      />
      {result.message}
    </>
  )
}

function returned(): FieldMessage {
  if (captured === undefined) throw new Error('Field has not rendered')
  return captured
}

/**
 * The reference, resolved. `attribute` is what the control claims to be described by;
 * `target` is the element that claim actually reaches. A dangling reference is an
 * attribute with a `null` target, and nothing else in a test can see it.
 */
function describedElement(label = 'Legal name'): {
  attribute: string | null
  target: HTMLElement | null
} {
  const control = screen.getByLabelText(label)
  const attribute = control.getAttribute('aria-describedby')
  return { attribute, target: attribute === null ? null : document.getElementById(attribute) }
}

describe('the invariant: the attribute is set exactly when the element it names exists', () => {
  it('names nothing and renders nothing when there is neither hint nor error', () => {
    const { container } = render(<Field />)

    /* Both halves of "neither". The returned id is absent... */
    expect(returned().describedBy).toBeUndefined()
    expect(describedElement().attribute).toBeNull()
    /* ...and so is the element, which is the half that a test asserting only the
     * attribute would leave unchecked in the opposite direction. */
    expect(returned().message).toBeNull()
    expect(container.querySelector('p')).toBeNull()
    expect(screen.getByLabelText('Legal name')).toHaveAccessibleDescription('')
  })

  it('returns an id AND puts an element carrying it in the document, for a hint', () => {
    render(<Field hint={HINT} />)

    expect(returned().describedBy).toBe(`${FIELD_ID}-message`)

    const { attribute, target } = describedElement()
    expect(attribute).toBe(`${FIELD_ID}-message`)
    /* The reference resolves. Not `toBeTruthy` on the attribute — the element. */
    expect(target).not.toBeNull()
    expect(target?.textContent).toBe(HINT)
    expect(screen.getByLabelText('Legal name')).toHaveAccessibleDescription(HINT)
  })

  it('returns an id AND puts an element carrying it in the document, for an error', () => {
    render(<Field error={ERROR} />)

    expect(returned().describedBy).toBe(`${FIELD_ID}-message`)

    const { attribute, target } = describedElement()
    expect(attribute).toBe(`${FIELD_ID}-message`)
    expect(target).not.toBeNull()
    expect(target?.textContent).toBe(ERROR)
    expect(screen.getByLabelText('Legal name')).toHaveAccessibleDescription(ERROR)
  })

  it('stops naming the element in the same render that stops drawing it', () => {
    /* The transition, which is where a dangling reference is actually created: a field
     * whose error clears keeps the attribute if the two halves are decided separately. */
    const { container, rerender } = render(<Field error={ERROR} />)
    expect(describedElement().target).not.toBeNull()

    rerender(<Field />)

    expect(describedElement().attribute).toBeNull()
    expect(container.querySelector('p')).toBeNull()
    expect(screen.getByLabelText('Legal name')).toHaveAccessibleDescription('')
  })

  it('derives the id from the field, so one field is never described by another', () => {
    /* Two on a screen. A message id that ignored the field id would point both controls
     * at the first paragraph — invisible on screen, wrong to anyone listening. */
    render(
      <>
        <Field id="legal" label="Legal name" hint={HINT} />
        <Field id="trade" label="Trade name" hint={ERROR} />
      </>,
    )

    const legal = describedElement('Legal name')
    const trade = describedElement('Trade name')
    expect(legal.attribute).toBe('legal-message')
    expect(trade.attribute).toBe('trade-message')
    expect(legal.target?.textContent).toBe(HINT)
    expect(trade.target?.textContent).toBe(ERROR)
  })
})

describe('which message, and the condition that picks it', () => {
  it('shows the error instead of the hint when both are given', () => {
    render(<Field hint={PRECEDENCE_HINT} error={PRECEDENCE_ERROR} />)

    const { target } = describedElement()
    /* Compared entire. The error is a substring of the hint, so a paragraph still
     * showing the hint would pass an unanchored `toHaveTextContent(PRECEDENCE_ERROR)`. */
    expect(target?.textContent).toBe(PRECEDENCE_ERROR)
    /* The hint's own absence, asserted beside the error's presence and in a render where
     * the hint would otherwise be on screen — not the absence of a string nothing draws. */
    expect(screen.queryByText(PRECEDENCE_HINT)).toBeNull()
    expect(screen.getByLabelText('Legal name')).toHaveAccessibleDescription(PRECEDENCE_ERROR)
  })

  it('shows the hint when there is no error', () => {
    render(<Field hint={PRECEDENCE_HINT} />)

    const { target } = describedElement()
    expect(target?.textContent).toBe(PRECEDENCE_HINT)
    expect(target).toHaveClass('field__hint')
  })

  /*
   * THE INPUT THAT ONLY `error !== undefined` EXCLUDES. Truthiness gets every case above
   * right and this one wrong: `error=''` would fall through to the hint, so a field the
   * validator had just rejected would sit there showing its guidance, unmarked, with the
   * rejection nowhere. The condition is `undefined`, in all three places it is asked.
   */
  it('treats an empty error as an error, not as no error', () => {
    render(<Field hint={HINT} error="" />)

    const { attribute, target } = describedElement()
    expect(attribute).toBe(`${FIELD_ID}-message`)
    expect(target).not.toBeNull()
    /* Empty, and rendered anyway — the element exists, so the reference is not dangling. */
    expect(target?.textContent).toBe('')
    expect(target).toHaveClass('field__error')
    expect(target).toHaveAttribute('role', 'alert')
    expect(returned().invalid).toBe(true)
    /* And the hint it replaced is gone, in a render where it would otherwise show. */
    expect(screen.queryByText(HINT)).toBeNull()
  })

  /* The same question asked of the hint: `text !== undefined`, not `text`. An empty hint
   * is a caller's empty string, and the paragraph is still there to be pointed at. */
  it('treats an empty hint as a hint, not as no hint', () => {
    const { container } = render(<Field hint="" />)

    expect(returned().describedBy).toBe(`${FIELD_ID}-message`)
    const { target } = describedElement()
    expect(target).not.toBeNull()
    expect(target?.textContent).toBe('')
    expect(target).toHaveClass('field__hint')
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('takes a hint made of elements, not only of words', () => {
    /* `PassphraseField`, `PathField` and `CheckboxField` all pass a `ReactNode`. */
    render(
      <Field
        hint={
          <>
            Both files go here. <strong>Not a temporary folder.</strong>
          </>
        }
      />,
    )

    const { target } = describedElement()
    expect(target?.textContent).toBe('Both files go here. Not a temporary folder.')
    expect(target?.querySelector('strong')?.textContent).toBe('Not a temporary folder.')
  })
})

describe('what the message is announced as', () => {
  it('is an alert when it is an error and not when it is a hint', () => {
    const { rerender } = render(<Field hint={HINT} />)

    /* Asserted beside the hint's presence: `queryByRole` returning null is only evidence
     * in a render where something IS on screen to have had the role. */
    expect(screen.getByText(HINT)).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<Field error={ERROR} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(ERROR)
    expect(alert).toBe(describedElement().target)
  })

  it('styles a hint and an error differently, and says so in the class attribute alone', () => {
    const { rerender } = render(<Field hint={HINT} />)

    /* The whole attribute, not `toHaveClass`: `filter(Boolean)` is what keeps the empty
     * extra class from leaving `class="field__hint "` behind, and only an exact read
     * can see the difference. */
    expect(describedElement().target?.getAttribute('class')).toBe('field__hint')

    rerender(<Field error={ERROR} />)

    expect(describedElement().target?.getAttribute('class')).toBe('field__error')
  })

  it('appends an extra class without dropping its own', () => {
    /* `CheckboxField` passes `checkbox__hint` beside the base class. */
    const { rerender } = render(<Field hint={HINT} className="checkbox__hint" />)

    expect(describedElement().target?.getAttribute('class')).toBe('field__hint checkbox__hint')

    rerender(<Field error={ERROR} className="checkbox__hint" />)

    expect(describedElement().target?.getAttribute('class')).toBe('field__error checkbox__hint')
  })
})

describe('the validity the same condition decides', () => {
  it('reports nothing to mark when there is no message at all', () => {
    render(<Field />)

    expect(returned().invalid).toBeUndefined()
    expect(screen.getByLabelText('Legal name')).not.toHaveAttribute('aria-invalid')
  })

  it('reports nothing to mark while the field merely has a hint', () => {
    render(<Field hint={HINT} />)

    /* A hint is not a failure. `undefined` rather than `false`, so React drops the
     * attribute instead of writing `aria-invalid="false"` under every hint in the app. */
    expect(returned().invalid).toBeUndefined()
    expect(screen.getByLabelText('Legal name')).not.toHaveAttribute('aria-invalid')
  })

  it('marks the field invalid when it has an error', () => {
    render(<Field error={ERROR} />)

    expect(returned().invalid).toBe(true)
    expect(screen.getByLabelText('Legal name')).toHaveAttribute('aria-invalid', 'true')
  })
})
