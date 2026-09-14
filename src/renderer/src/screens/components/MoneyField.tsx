/*
 * A field that takes an amount of money.
 *
 * The Input atom with two things decided for it: the currency symbol in a well at the start
 * of the box, taken from the open company's regime, and a right-aligned value in tabular
 * figures so it lines up with the column it will join (design system §03, "Money field").
 *
 * WHAT IT DOES NOT DO, ON PURPOSE: parse, round, group or validate. The value is the string
 * the user typed, handed back as typed. Every figure is worked out in the main process
 * (docs/design.md §4, "The renderer never computes money"), so a field that reformatted
 * "1,00,000" as the user left it would be arithmetic in a component under another name.
 *
 * Here rather than among the atoms because it reads the regime store, and an atom may not
 * depend on which company is open.
 */

import type { ComponentProps, JSX } from 'react'
import { Input } from '@renderer/components/atoms'
import { useNumberFormat } from '@renderer/store/regime'

type MoneyFieldProps = Omit<ComponentProps<typeof Input>, 'prefix' | 'isFigure' | 'inputMode'>

export function MoneyField(props: MoneyFieldProps): JSX.Element {
  const { currencySymbol } = useNumberFormat()
  return <Input {...props} prefix={currencySymbol} isFigure inputMode="decimal" />
}
