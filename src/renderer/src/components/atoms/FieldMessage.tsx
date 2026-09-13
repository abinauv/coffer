/*
 * The message under a field — the hint, or the error that replaces it — together with
 * the `aria-describedby` that points at it.
 *
 * WHY THIS EXISTS: ONE DECISION, COUNTED AT FIVE SITES. `Input`, `Select`,
 * `PassphraseField`, `PathField` and `CheckboxField` each carried their own copy of
 *
 *     const messageId = `${id}-message`
 *     const message = error ?? hint
 *     aria-describedby={message === undefined ? undefined : messageId}
 *     <p className={error === undefined ? 'field__hint' : 'field__error'}
 *        role={error === undefined ? undefined : 'alert'}>
 *
 * `Select` next door was extracted when one field bug had been written by hand TWICE.
 * This one had been written five times — and this project's rule is that the second copy
 * is the signal to move the shape into an atom, not to fix it a second time.
 *
 * THE DECISION IT OWNS is not "what does the message say". It is "does this attribute
 * point at an element that is actually in the document" — and that question has already
 * been got wrong here. Until 0016 `Dialog` set `aria-labelledby` from its title while
 * rendering the `<h2>` only in its chrome branch, so a chromeless titled dialog
 * announced an accessible name of `""`: worse than no name at all, because an empty name
 * is still a name and nothing further is looked for. `CommandPalette` writes the same
 * warning beside its `aria-controls`. A dangling reference is invisible on screen,
 * invisible in a screenshot, and invisible to any test that asserts only the attribute —
 * which is why the tests here assert BOTH halves, the id returned and the element it
 * names, every time.
 *
 * THE INVARIANT, which no caller may restate:
 *
 *     `aria-describedby` is set IF AND ONLY IF the element it names is in the document.
 *
 * WHY ONE CALL, AND NOT A HOOK BESIDE A COMPONENT. `useFieldMessage(…)` for the id and a
 * separate `<FieldMessage …/>` for the paragraph would decide the same thing twice from
 * the same props — the shape being collapsed, written at two places instead of five —
 * and would leave every caller free to take the id and then render the element in a
 * branch, or forget it. That is precisely the `Dialog` failure, re-offered. So one call
 * returns both halves: the attribute value and the element it names are the same fact,
 * and a caller who drops `message` is visibly dropping half of an object it was handed.
 *
 * `invalid` rides along because it is the SAME condition — `error === undefined` — spelt
 * out three more times across the same five files. The two callers with no invalid state
 * to report simply do not read it.
 */

import type { JSX, ReactNode } from 'react'

/** What one call gives a field: two attribute values, and the element they name. */
export interface FieldMessage {
  /**
   * The control's `aria-describedby`: the message's id when there is a message, and
   * `undefined` when there is not. Never an id that nothing renders.
   */
  describedBy: string | undefined
  /** The control's `aria-invalid`: `true` exactly when there is an error. */
  invalid: true | undefined
  /** The message paragraph. Rendered if and only if `describedBy` is set. */
  message: JSX.Element | null
}

interface FieldMessageOptions {
  /** The field's own id — the control's, or the label's where there is no control. */
  id: string
  /** Guidance under the field. Replaced by `error` when there is one. */
  hint?: ReactNode
  /** What is wrong and what to do about it. See docs/CONVENTIONS.md §5. */
  error?: string
  /** An extra class on the paragraph, beside `field__hint` / `field__error`. */
  className?: string
}

export function useFieldMessage({ id, hint, error, className }: FieldMessageOptions): FieldMessage {
  /* `??` and `!== undefined`, never truthiness: AN EMPTY ERROR IS STILL AN ERROR. A
   * validator that returned '' would otherwise leave the field reading as valid with its
   * hint still underneath, as though nothing had been found wrong. */
  const text = error ?? hint
  const isError = error !== undefined
  const hasMessage = text !== undefined
  const messageId = `${id}-message`

  return {
    /* `describedBy` and `message` read the SAME `hasMessage`. That is the whole atom:
     * one condition, so there is no state in which the attribute names an element that
     * was not rendered. */
    describedBy: hasMessage ? messageId : undefined,
    invalid: isError ? true : undefined,
    message: hasMessage ? (
      <p
        id={messageId}
        className={[isError ? 'field__error' : 'field__hint', className ?? '']
          .filter(Boolean)
          .join(' ')}
        /* Only a validation failure interrupts; a static hint does not. */
        role={isError ? 'alert' : undefined}
      >
        {text}
      </p>
    ) : null,
  }
}
