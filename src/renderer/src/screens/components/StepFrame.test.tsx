/*
 * The frame a flow in steps sits in.
 *
 * Where you are is said three ways, and the tests hold all three: `aria-current="step"` on
 * the step on show, "Step 2 of 3" in words for a screen reader, and the finished steps
 * marked done. And the footer holds only what the step passes: the recovery codes have no
 * Back, so the frame must never add one.
 */

import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderScreen } from '@renderer/test/harness'
import { StepCard, StepFrame } from './StepFrame'

const STEPS = ['The company', 'The passphrase', 'Recovery codes'] as const

function mount(overrides: Partial<Parameters<typeof StepFrame>[0]> = {}): void {
  renderScreen(
    <StepFrame
      flowLabel="Creating a company"
      steps={STEPS}
      current={1}
      title="Choose a passphrase"
      primary={<button type="button">Create the company</button>}
      {...overrides}
    >
      <p>the step’s content</p>
    </StepFrame>,
  )
}

function steps(): HTMLElement[] {
  return within(screen.getByRole('navigation', { name: 'Creating a company' })).getAllByRole(
    'listitem',
  )
}

describe('the steps', () => {
  it('marks the step on show, and only it', () => {
    mount()

    expect(steps().map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null])
  })

  it('says where it is in words, and which steps are done', () => {
    mount()

    expect(steps()[0]).toHaveTextContent('Step 1 of 3, done: The company')
    expect(steps()[1]).toHaveTextContent('Step 2 of 3: The passphrase')
    expect(steps()[2]).toHaveTextContent('Step 3 of 3: Recovery codes')
  })

  it('draws each state for the stylesheet', () => {
    mount({ current: 2 })

    expect(steps().map((step) => step.dataset['state'])).toEqual(['done', 'done', 'current'])
  })
})

describe('the step', () => {
  it('has its title as the page heading, and its content', () => {
    mount({ lede: 'It is not stored anywhere.', status: 'Acme created' })

    expect(screen.getByRole('heading', { level: 1, name: 'Choose a passphrase' })).toBeVisible()
    expect(screen.getByText('It is not stored anywhere.')).toBeVisible()
    expect(screen.getByText('Acme created')).toBeVisible()
    expect(screen.getByText('the step’s content')).toBeVisible()
  })

  it('puts the cards in a complementary region beside it', () => {
    mount({
      aside: (
        <StepCard title="There is no back door" tone="warning">
          <p>Nobody can reset it.</p>
        </StepCard>
      ),
    })

    const aside = screen.getByRole('complementary')
    expect(within(aside).getByRole('heading', { name: 'There is no back door' })).toBeVisible()
    expect(aside.querySelector('.step-card')).toHaveAttribute('data-tone', 'warning')
  })
})

describe('the footer', () => {
  it('holds the way back, the hint and the way on', () => {
    mount({
      back: <button type="button">Back</button>,
      hint: 'Type it again to confirm',
    })

    const foot = screen.getByRole('contentinfo')
    expect(within(foot).getByRole('button', { name: 'Back' })).toBeVisible()
    expect(within(foot).getByText('Type it again to confirm')).toBeVisible()
    expect(within(foot).getByRole('button', { name: 'Create the company' })).toBeVisible()
  })

  /* The recovery codes pass no Back, and there must be none. */
  it('adds no way back of its own', () => {
    mount({ current: 2 })

    expect(within(screen.getByRole('contentinfo')).getAllByRole('button')).toHaveLength(1)
  })

  it('draws no hint when there is nothing to say', () => {
    mount({ hint: null })

    expect(document.querySelector('.step-frame__hint')).toBeNull()
  })
})
