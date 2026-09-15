/*
 * The frame a multi-step flow sits in: the steps across the top, the step's own content
 * with the cards that explain it beside, and a footer holding the way back and the way on.
 *
 * Creating a company is three steps in this frame (the design's First Run). Each step says
 * where it is in words as well as by colour — "Step 2 of 3" for a screen reader, a filled
 * number and `aria-current="step"` for the step on show — and the finished ones say so.
 *
 * WHAT THE FOOTER HOLDS IS THE STEP'S TO DECIDE. The recovery codes have no Back, so a
 * step that offers none simply passes none; the frame never adds one of its own. And the
 * hint beside the primary button is where a disabled button says why it is disabled.
 */

import type { JSX, ReactNode } from 'react'
import { TitleBarSync } from './TitleBarSync'
import '../screens.css'

interface StepFrameProps {
  /** What the whole flow is, for the list of steps: "Creating a company". */
  flowLabel: string
  /** Every step's short name, in order. */
  steps: readonly string[]
  /** Zero-based. */
  current: number
  title: string
  lede?: ReactNode
  /** A line above the title, such as what the previous step just did. */
  status?: ReactNode
  /** The cards beside the content. They explain; nothing in them is required reading. */
  aside?: ReactNode
  /** The way back, when this step has one. */
  back?: ReactNode
  /** Why the primary action cannot run yet, beside it. */
  hint?: ReactNode
  /** The way on. */
  primary: ReactNode
  children: ReactNode
}

export function StepFrame({
  flowLabel,
  steps,
  current,
  title,
  lede,
  status,
  aside,
  back,
  hint,
  primary,
  children,
}: StepFrameProps): JSX.Element {
  return (
    <div className="step-frame">
      <TitleBarSync />

      <nav className="step-frame__steps" aria-label={flowLabel}>
        <ol className="step-frame__list">
          {steps.map((label, index) => {
            const state = index < current ? 'done' : index === current ? 'current' : 'todo'
            return (
              <li
                key={label}
                className="step-frame__step"
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="step-frame__number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="visually-hidden">
                  {`Step ${index + 1} of ${steps.length}${state === 'done' ? ', done' : ''}: `}
                </span>
                {label}
              </li>
            )
          })}
        </ol>
      </nav>

      <div className="step-frame__body">
        <div className="step-frame__main">
          <header className="step-frame__head">
            {status !== undefined && <div className="step-frame__status">{status}</div>}
            <h1 className="page__title">{title}</h1>
            {lede !== undefined && <p className="page__lede">{lede}</p>}
          </header>
          {children}
        </div>
        {aside !== undefined && <aside className="step-frame__aside">{aside}</aside>}
      </div>

      <footer className="step-frame__foot">
        <div className="step-frame__back">{back}</div>
        <div className="step-frame__forward">
          {hint !== undefined && hint !== null && hint !== '' && (
            <p className="step-frame__hint">{hint}</p>
          )}
          {primary}
        </div>
      </footer>
    </div>
  )
}

/** A card beside a step: a title and a few sentences. `tone` marks the one that warns. */
export function StepCard({
  title,
  tone = 'plain',
  children,
}: {
  title: string
  tone?: 'plain' | 'warning' | 'danger'
  children: ReactNode
}): JSX.Element {
  return (
    <section className="step-card" data-tone={tone}>
      <h2 className="step-card__title">{title}</h2>
      <div className="step-card__body">{children}</div>
    </section>
  )
}
