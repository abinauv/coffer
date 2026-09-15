/*
 * The Country picker, for the business and for a party (B13).
 *
 * Names on screen, the lower-case code in the books. See lib/countries.ts for where each comes
 * from and why a code the list does not know is kept.
 */

import { useMemo } from 'react'
import type { JSX } from 'react'
import { Select } from '@renderer/components/atoms'
import { countryOptions } from '../lib/countries'

interface CountrySelectProps {
  value: string
  onChange: (code: string) => void
  hint?: string
}

export function CountrySelect({ value, onChange, hint }: CountrySelectProps): JSX.Element {
  const options = useMemo(() => countryOptions(value), [value])
  return (
    <Select
      label="Country"
      value={value.trim().toLowerCase()}
      hint={hint}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose a country</option>
      {options.map((option) => (
        <option key={option.code} value={option.code}>
          {option.label}
        </option>
      ))}
    </Select>
  )
}
