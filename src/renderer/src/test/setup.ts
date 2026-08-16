import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { takeMissedChannels, uninstallBridge } from './harness'

/*
 * Runs before every renderer test file.
 *
 * WHY happy-dom AND NOT jsdom. Both were run against the same probe — the real
 * `Dialog` atom, rendered — before choosing, and the result was not close:
 *
 *                              happy-dom 20      jsdom 30
 *     HTMLDialogElement        function          function
 *     .showModal()             opens it          undefined
 *     window.matchMedia        function          undefined
 *     environment setup        1.1s              54.6s
 *
 * jsdom is the better-known answer and it is the wrong one here. Every modal in this
 * product is the native element driven by `showModal()` (components/atoms/Dialog.tsx),
 * so under jsdom no dialog opens and nothing inside one can be asserted at all — while
 * `typeof HTMLDialogElement === 'function'` still reports success, which is how a broken
 * environment passes a smoke test. `matchMedia` is what the ThemeProvider reads to
 * follow the system appearance, and a missing one throws on mount.
 */

afterEach(() => {
  /*
   * React Testing Library unmounts what a test rendered only when it can find a global
   * `afterEach`, and this project does not enable Vitest's globals — every test imports
   * `describe` and `it`. So the auto-cleanup never fires and has to be asked for.
   * Without it the document accumulates every tree the file rendered, and `getByRole`
   * starts failing with "found multiple elements" in the second test that renders the
   * same screen — a failure that points at the test rather than at the mistake.
   */
  cleanup()
  uninstallBridge()

  /*
   * A channel nothing answered fails the test that reached it, here rather than where it
   * happened. `callApi` swallows the throw by design, so the screen under test just
   * renders "That action could not be completed" and the real assertion fails for a
   * reason that says nothing about the missing stub. This says it.
   */
  const missed = takeMissedChannels()
  if (missed.length > 0) {
    const unique = [...new Set(missed)]
    throw new Error(
      `This test called ${unique.length === 1 ? 'a channel' : 'channels'} the bridge stub ` +
        `does not answer: ${unique.join(', ')}. Add ${unique.length === 1 ? 'it' : 'them'} ` +
        `to the \`bridge\` passed to renderScreen, or the screen is being tested against ` +
        `an error path it did not mean to take.`,
    )
  }
})
