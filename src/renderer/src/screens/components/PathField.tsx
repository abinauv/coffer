/*
 * "Where should this go?" — a path the user chose in a native dialog, shown back to them.
 *
 * The path is displayed, never typed. The renderer cannot browse the filesystem and
 * should not pretend to: every path on these screens comes from `system.chooseDirectory`,
 * `system.chooseCompanyFile` or `system.chooseBackupArchive`, which is also what puts it
 * on the main process's allowlist for revealing later.
 */

import { useId } from 'react'
import type { JSX, ReactNode } from 'react'
import { Button, useFieldMessage } from '@renderer/components/atoms'

interface PathFieldProps {
  label: string
  /** The chosen path, or the empty string. */
  value: string
  /** Shown in place of the path before one is chosen. */
  placeholder: string
  buttonLabel: string
  onChoose: () => void
  hint?: ReactNode
  error?: string
  isDisabled?: boolean
}

export function PathField({
  label,
  value,
  placeholder,
  buttonLabel,
  onChoose,
  hint,
  error,
  isDisabled = false,
}: PathFieldProps): JSX.Element {
  const id = useId()
  const { describedBy, message } = useFieldMessage({ id, hint, error })

  return (
    <div className="field path-field">
      <span className="field__label" id={id}>
        {label}
      </span>
      <div className="path-field__row">
        <p
          className={`path-field__value ${value === '' ? 'path-field__value--empty' : 'selectable'}`}
          aria-labelledby={id}
          aria-describedby={describedBy}
          title={value === '' ? undefined : value}
        >
          {value === '' ? placeholder : value}
        </p>
        <Button icon="folder" onClick={onChoose} disabled={isDisabled}>
          {buttonLabel}
        </Button>
      </div>
      {message}
    </div>
  )
}
