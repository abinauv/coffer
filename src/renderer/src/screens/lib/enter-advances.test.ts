/// <reference types="node" />
import { beforeEach, describe, expect, it } from 'vitest'
import { advanceFrom, fieldsIn, isAdvanceField, isAdvanceKey } from './enter-advances'

function draw(html: string): HTMLElement {
  document.body.innerHTML = `<div id="editor">${html}</div>`
  const container = document.querySelector('#editor')
  if (!(container instanceof HTMLElement)) throw new Error('no container')
  return container
}

const field = (id: string): HTMLElement => {
  const element = document.querySelector(`#${id}`)
  if (!(element instanceof HTMLElement)) throw new Error(`no ${id}`)
  return element
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isAdvanceField', () => {
  it('takes an enabled input or select, and nothing else', () => {
    draw(`
      <input id="text" />
      <select id="choice"><option value="">x</option></select>
      <input id="off" disabled />
      <input id="fixed" readonly />
      <input id="hidden" type="hidden" />
      <textarea id="prose"></textarea>
      <button id="go">Go</button>
    `)
    expect(isAdvanceField(field('text'))).toBe(true)
    expect(isAdvanceField(field('choice'))).toBe(true)
    /* Landing on a control that cannot be used reads as a screen that has stopped. */
    expect(isAdvanceField(field('off'))).toBe(false)
    expect(isAdvanceField(field('fixed'))).toBe(false)
    expect(isAdvanceField(field('hidden'))).toBe(false)
    expect(isAdvanceField(field('prose'))).toBe(false)
    expect(isAdvanceField(field('go'))).toBe(false)
  })
})

describe('advanceFrom', () => {
  it('moves to the next field, skipping what cannot be typed in', () => {
    const container = draw(`<input id="a" /><input id="fixed" readonly /><input id="b" />`)
    expect(advanceFrom(container, field('a'))).toEqual({ kind: 'focus', element: field('b') })
  })

  it('stops at the end rather than wrapping round to the top', () => {
    const container = draw(`<input id="a" /><input id="b" />`)
    expect(advanceFrom(container, field('b'))).toEqual({ kind: 'none' })
  })

  const GRID = `
    <input id="date" />
    <table>
      <tr data-line-key="one"><td><input id="one-a" /></td><td><input id="one-b" /></td></tr>
      <tr data-line-key="two"><td><input id="two-a" /></td><td><input id="two-b" /></td></tr>
    </table>
    <input id="narration" />
  `

  it('jumps from the end of a line to the start of the next one', () => {
    const container = draw(GRID)
    expect(advanceFrom(container, field('one-b'))).toEqual({
      kind: 'focus',
      element: field('two-a'),
    })
  })

  /* The keystroke people actually mean at the end of a line: another line. */
  it('asks for a new line at the end of the last one', () => {
    const container = draw(GRID)
    expect(advanceFrom(container, field('two-b'))).toEqual({ kind: 'add-line' })
  })

  it('moves across a line without leaving it', () => {
    const container = draw(GRID)
    expect(advanceFrom(container, field('two-a'))).toEqual({
      kind: 'focus',
      element: field('two-b'),
    })
  })

  it('walks into the grid from the fields above it', () => {
    const container = draw(GRID)
    expect(advanceFrom(container, field('date'))).toEqual({
      kind: 'focus',
      element: field('one-a'),
    })
  })

  /* A row whose last field is disabled ends at the last one that can be typed in. */
  it('reads the end of a line as its last usable field', () => {
    const container = draw(`
      <table>
        <tr data-line-key="one"><td><input id="one-a" /></td><td><input id="one-b" disabled /></td></tr>
      </table>
    `)
    expect(advanceFrom(container, field('one-a'))).toEqual({ kind: 'add-line' })
  })

  it('says nothing for an element that is not in the container', () => {
    const container = draw(`<input id="a" />`)
    document.body.insertAdjacentHTML('beforeend', '<input id="outside" />')
    expect(advanceFrom(container, field('outside'))).toEqual({ kind: 'none' })
  })
})

describe('fieldsIn', () => {
  it('reads the fields in the order the document is read', () => {
    const container = draw(`<input id="a" /><select id="b"></select><input id="c" />`)
    expect(fieldsIn(container).map((element) => element.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('isAdvanceKey', () => {
  const on = (over: Partial<Parameters<typeof isAdvanceKey>[0]> = {}) => {
    const container = draw(`<input id="a" /><textarea id="prose"></textarea>`)
    void container
    return isAdvanceKey({
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: field('a'),
      ...over,
    })
  }

  it('is a plain Enter in a field', () => {
    expect(on()).toBe(true)
  })

  /* Ctrl Enter accepts the document. Advancing as well would do both at once. */
  it('is not Ctrl Enter, Cmd Enter or Shift Enter', () => {
    expect(on({ ctrlKey: true })).toBe(false)
    expect(on({ metaKey: true })).toBe(false)
    expect(on({ shiftKey: true })).toBe(false)
  })

  it('leaves a textarea its own Enter, so a narration can hold two lines', () => {
    draw(`<textarea id="prose"></textarea>`)
    expect(on({ target: field('prose') })).toBe(false)
  })

  it('is not any other key', () => {
    expect(on({ key: 'Tab' })).toBe(false)
  })
})
