/*
 * Building HTML out of values a user typed, without ever forgetting to escape one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TAGGED TEMPLATE AND NOT AN `escapeHtml()` EVERYONE REMEMBERS TO CALL
 *
 * Every string on an invoice is free text somebody typed into a form: a customer called
 * `Sharma & Sons <Pvt> Ltd`, a narration with a quote in it, an address line with an
 * ampersand. A bare `escapeHtml` helper puts the escaping decision at every one of the
 * ~60 interpolation sites in the template, which means the batch that adds the 61st is
 * the batch that ships an invoice with a broken party name on it — and, the first time
 * one of these documents is shown in a window rather than handed to a PDF writer, a
 * script-injection route.
 *
 * So the default is inverted. `html` escapes every interpolated value, and the only way
 * to put markup in is to say `raw(...)` out loud. Forgetting produces a visibly escaped
 * tag in the output — loud, harmless, and caught by the first test that looks — where
 * forgetting the other way round produces a document that renders fine until the day
 * somebody's trading name has a bracket in it.
 *
 * `Html` is a class rather than a branded string because a brand is a compile-time
 * fiction: `raw` and a plain `string` would be the same value at runtime, and a template
 * that received the wrong one would concatenate it happily. An instance check cannot be
 * got wrong by a cast.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ESCAPED, AND WHY IT IS FIVE CHARACTERS RATHER THAN THREE
 *
 * `&`, `<` and `>` are the text-content set. `"` and `'` are here because the template
 * puts values in ATTRIBUTES — an image's `src` and `alt`, a column's `style` — and an
 * unescaped quote there closes the attribute and starts a new one, which is the whole
 * injection in a single character. Escaping both quote forms everywhere means there is
 * one function and no site where somebody has to know which context they are in.
 *
 * `&` IS REPLACED FIRST, and it has to be: doing it last would find the ampersands the
 * earlier replacements had just written and turn `&lt;` into `&amp;lt;`. A single pass
 * over a character class cannot make that mistake, which is why this is one `replace`
 * with a lookup rather than five chained ones.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** One pass, so a replacement's own output is never re-scanned. See the header. */
const ESCAPABLE = /[&<>"']/g

/** Text as it may appear in element content or inside a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(ESCAPABLE, (character) => ESCAPES[character] ?? character)
}

/**
 * A fragment that is already HTML.
 *
 * The only thing `html` passes through untouched, so the type is the audit trail: search
 * for `raw(` and you have every place in this module where a string became markup.
 */
export class Html {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }

  toString(): string {
    return this.value
  }
}

/**
 * What may be interpolated.
 *
 * `null`, `undefined` and `false` render as nothing, so an optional block is written
 * `condition && html\`…\`` and an absent field is written `value` — neither needs a
 * ternary with an empty string in it. `true` is deliberately NOT in the union: it has no
 * printable meaning, and allowing it would make `flag && ...` silently print `true` when
 * somebody swapped the operands.
 */
export type HtmlValue = string | number | Html | null | undefined | false | readonly HtmlValue[]

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return ''
  if (value instanceof Html) return value.value
  /* A number's text is digits, a sign, a point and possibly an exponent — nothing the
   * escaper would touch. It goes through it anyway so that there is one path out of this
   * function that produces text, and no second one to reason about. */
  if (typeof value === 'number' || typeof value === 'string') return escapeHtml(String(value))
  return value.map(render).join('')
}

/**
 * HTML with every interpolated value escaped.
 *
 * ```ts
 * html`<td>${party.name}</td>`
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  let out = strings[0] ?? ''
  for (let index = 0; index < values.length; index += 1) {
    out += render(values[index]) + (strings[index + 1] ?? '')
  }
  return new Html(out)
}

/**
 * Markup this module built, passed through unescaped.
 *
 * Never call this on anything that came from a document, a party or a profile. The only
 * legitimate arguments are constants in this folder — the stylesheet, and separators.
 */
export function raw(value: string): Html {
  return new Html(value)
}

/**
 * Several fragments, one per line, with the empty ones dropped.
 *
 * Whitespace between elements is nothing to HTML and everything to somebody opening the
 * file a PDF was rendered from, which is the first thing anyone does when a column is in
 * the wrong place.
 */
export function lines(values: readonly HtmlValue[]): Html {
  return new Html(
    values
      .map(render)
      .filter((part) => part !== '')
      .join('\n'),
  )
}

/** What the template finally hands back: a string, with the wrapper taken off. */
export function toHtmlString(fragment: Html): string {
  return fragment.value
}
