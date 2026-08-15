/*
 * A failure, on the screen it happened on, with the one thing worth doing about it.
 *
 * The copy comes from ../lib/messages.ts, which has an entry for every code the main
 * process can raise. The action does not: a screen passes handlers for the routes it can
 * actually offer, and any it cannot simply does not get a button. Better no button than
 * one that goes nowhere.
 */

import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import type { AppError } from '@shared/dto'
import {
  describeFailure,
  failureDetail,
  type ErrorAction,
  type FailureContext,
} from '../lib/messages'
import { Notice } from './Notice'

/** What each offer is called on a button. Kept short: the notice body has the sentence. */
const ACTION_LABELS: Record<ErrorAction, string> = {
  recover: 'Use a recovery code',
  'add-existing': 'Find the file',
  restore: 'Restore from a backup',
  refresh: 'Check again',
}

interface FailureNoticeProps {
  error: AppError
  context?: FailureContext
  /** Handlers for the offers this screen can honour. */
  onAction?: Partial<Record<ErrorAction, () => void>>
}

export function FailureNotice({
  error,
  context = 'general',
  onAction,
}: FailureNoticeProps): JSX.Element {
  const guidance = describeFailure(error, context)
  const detail = failureDetail(error, context)
  const handler = guidance.action === null ? undefined : onAction?.[guidance.action]

  return (
    <Notice
      tone="danger"
      title={guidance.title}
      detail={detail}
      actions={
        handler && guidance.action !== null ? (
          <Button size="sm" onClick={handler}>
            {ACTION_LABELS[guidance.action]}
          </Button>
        ) : undefined
      }
    >
      <p>{guidance.body}</p>
    </Notice>
  )
}
