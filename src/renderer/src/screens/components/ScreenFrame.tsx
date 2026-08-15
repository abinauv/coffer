/*
 * The frame every company screen sits in: a heading, an optional lead paragraph, the
 * actions that belong to the screen as a whole, and the body.
 *
 * It is here rather than in components/shell because this batch owns screens/ only. If a
 * later batch wants this shape for every screen in the product, it belongs upstairs.
 */

import type { JSX, ReactNode } from 'react'
import { Button } from '@renderer/components/atoms'
import { TitleBarSync } from './TitleBarSync'
import '../screens.css'

interface ScreenFrameProps {
  title: string
  /** One or two sentences under the title. Says what this screen is for. */
  lede?: ReactNode
  /** Buttons that act on the screen rather than on anything in it. */
  actions?: ReactNode
  /** A way back, when this screen was reached from another. */
  back?: { label: string; onClick: () => void }
  /** 'form' is a reading column; 'list' is wider, for the picker. */
  width?: 'form' | 'list'
  /**
   * Adds the padding the workspace does not supply. The welcome canvas already centres
   * and pads its content; `.app__main` does not.
   */
  isInset?: boolean
  children: ReactNode
}

export function ScreenFrame({
  title,
  lede,
  actions,
  back,
  width = 'form',
  isInset = false,
  children,
}: ScreenFrameProps): JSX.Element {
  const classes = ['page', `page--${width}`, isInset ? 'page--inset' : ''].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      <TitleBarSync />

      <header className="page__head">
        {back && (
          <Button variant="ghost" size="sm" icon="chevron-left" onClick={back.onClick}>
            {back.label}
          </Button>
        )}
        <div className="page__heading">
          <h1 className="page__title">{title}</h1>
          {lede !== undefined && <p className="page__lede">{lede}</p>}
        </div>
        {actions !== undefined && <div className="page__actions">{actions}</div>}
      </header>

      <div className="page__body">{children}</div>
    </div>
  )
}
