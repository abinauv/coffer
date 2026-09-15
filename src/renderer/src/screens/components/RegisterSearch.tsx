/*
 * A register's search box: typed into freely, sent to main when it is submitted.
 *
 * Typing is not searching. A query per keystroke would put a read of the books on every
 * letter of a customer's name, so the box holds what is typed and `onSubmit` is what asks.
 * Its width comes from its placeholder (B12), so the sentence it shows is never cut off.
 */

import type { JSX } from 'react'
import { Input } from '@renderer/components/atoms'
import { searchWidth } from '../lib/register-view'

interface RegisterSearchProps {
  placeholder: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
}

export function RegisterSearch({
  placeholder,
  value,
  onChange,
  onSubmit,
}: RegisterSearchProps): JSX.Element {
  return (
    <form
      className="register__search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Input
        label="Search"
        isLabelHidden
        icon="search"
        placeholder={placeholder}
        value={value}
        style={{ minWidth: searchWidth(placeholder) }}
        onChange={(event) => onChange(event.target.value)}
      />
    </form>
  )
}
