/*
 * The escaper, and the thing it is really for.
 *
 * An unescaped invoice is two bugs at once: a broken document — a customer called
 * `Sharma & Sons <Pvt> Ltd` whose name arrives mangled or missing — and, the moment one
 * of these pages is ever shown in a window rather than handed to a PDF writer, a
 * script-injection route. Both are tested below, and the second is tested with the
 * payload rather than with a character class, because a test that only checks `<`
 * becomes `&lt;` says nothing about whether a `<script>` survived somewhere else.
 */

import { describe, expect, it } from 'vitest'

import { Html, escapeHtml, html, lines, raw, toHtmlString } from './escape'

describe('escapeHtml', () => {
  it('escapes the three text characters and both quote characters', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  /*
   * The whole reason it is one pass over a character class. Chaining five replacements
   * with `&` last would find the ampersands the earlier ones had just written, and
   * `<` would come out as `&amp;lt;` — which renders as the text `&lt;` on the page.
   */
  it('does not double-escape the ampersands it writes itself', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;')
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('leaves everything else alone, including scripts and accents', () => {
    expect(escapeHtml('Café ₹ 1,234.00')).toBe('Café ₹ 1,234.00')
    expect(escapeHtml('')).toBe('')
  })

  /* Both quote forms, because a value lands in an attribute as often as in text and an
   * unescaped quote there closes the attribute — the whole injection in one character. */
  it('escapes a value that would break out of an attribute', () => {
    const attribute = `<img alt="${escapeHtml('" onerror="alert(1)')}" />`

    expect(attribute).toBe('<img alt="&quot; onerror=&quot;alert(1)" />')
    expect(attribute).not.toContain('onerror="')
  })
})

describe('the html tag', () => {
  it('escapes every interpolated string', () => {
    const party = 'Sharma & Sons <Pvt> Ltd'

    expect(toHtmlString(html`<td>${party}</td>`)).toBe('<td>Sharma &amp; Sons &lt;Pvt&gt; Ltd</td>')
  })

  it('escapes a value in an attribute as well as one in text', () => {
    const rendered = toHtmlString(html`<img alt="${'a" onerror="x'}" />`)

    expect(rendered).toBe('<img alt="a&quot; onerror=&quot;x" />')
  })

  it('renders a number', () => {
    expect(toHtmlString(html`<td>${42}</td>`)).toBe('<td>42</td>')
    expect(toHtmlString(html`<td>${-1.5}</td>`)).toBe('<td>-1.5</td>')
  })

  /* An absent field and an unchosen optional block are the same thing to a page, so
   * neither needs a ternary with an empty string on one arm. */
  it('renders null, undefined and false as nothing', () => {
    expect(toHtmlString(html`<td>${null}${undefined}${false}</td>`)).toBe('<td></td>')
  })

  it('joins an array, escaping each item', () => {
    expect(toHtmlString(html`${['a<', 'b&']}`)).toBe('a&lt;b&amp;')
  })

  /*
   * Compared with the whitespace collapsed, and that is not laziness. Prettier formats
   * the HTML inside an `html` tagged template as HTML — which is why the template file
   * reads as markup rather than as string soup — so a byte-for-byte assertion on one is
   * an assertion about the formatter's line width. Nothing in this batch compares raw
   * markup; the template's own tests read cells out of the table instead.
   */
  it('passes an Html fragment through unescaped, so fragments compose', () => {
    const cell = html`<td>${'a<b'}</td>`
    const row = toHtmlString(
      html`<tr>
        ${cell}
      </tr>`,
    )

    expect(row.replace(/\s+/g, '')).toBe('<tr><td>a&lt;b</td></tr>')
  })

  /* A nested array is how `map` inside `map` is written — the tax columns on a line. */
  it('flattens nested arrays', () => {
    expect(toHtmlString(html`${[['a'], [html`<b></b>`]]}`)).toBe('a<b></b>')
  })

  it('handles a template with no interpolations at all', () => {
    expect(toHtmlString(html`<hr />`)).toBe('<hr />')
  })

  /*
   * THE ASSERTION THIS FILE EXISTS FOR. Not that a bracket became an entity — that a
   * payload put through the tag cannot come out as markup.
   */
  it('cannot be made to emit a script tag', () => {
    const payload = '</td><script>alert(document.cookie)</script><td>'
    const rendered = toHtmlString(html`<td>${payload}</td>`)

    expect(rendered).not.toContain('<script')
    expect(rendered).not.toContain('</td><')
    expect(rendered).toContain('&lt;script&gt;')
  })
})

describe('raw', () => {
  it('is the only way past the escaper, and says so at the call site', () => {
    expect(toHtmlString(html`${raw('<b>bold</b>')}`)).toBe('<b>bold</b>')
    expect(toHtmlString(html`${'<b>bold</b>'}`)).toBe('&lt;b&gt;bold&lt;/b&gt;')
  })

  /*
   * A CLASS AND NOT A BRANDED STRING. A brand is a compile-time fiction — `raw('x')` and
   * `'x'` would be the same value at runtime and a mis-typed call would concatenate
   * happily. An instance check cannot be got wrong by a cast, and this is the assertion
   * that says the guarantee is a runtime one.
   */
  it('is distinguishable from a string at runtime', () => {
    expect(raw('x')).toBeInstanceOf(Html)
    expect(html`x`).toBeInstanceOf(Html)
    expect(String(raw('<b>'))).toBe('<b>')
  })
})

describe('lines', () => {
  it('puts one fragment per line and drops the empty ones', () => {
    expect(toHtmlString(html`${lines([html`<a></a>`, null, html`<b></b>`, false])}`)).toBe(
      '<a></a>\n<b></b>',
    )
  })

  it('escapes a bare string like anything else', () => {
    expect(toHtmlString(html`${lines(['a<', 'b&'])}`)).toBe('a&lt;\nb&amp;')
  })

  it('is empty when everything in it is', () => {
    expect(toHtmlString(html`${lines([null, undefined, false])}`)).toBe('')
  })
})
