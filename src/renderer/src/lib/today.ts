/*
 * Today, as the calendar on the user's wall has it.
 *
 * In lib/ because the shell needs it as well as the report screens: the title bar names the
 * financial year today falls in.
 */

/** Today as `YYYY-MM-DD`, in the user's own timezone. */
export function todayISO(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  /*
   * Not `toISOString().slice(0, 10)`, which converts to UTC first. For a user in India
   * that is five and a half hours earlier, so any time before 05:30 local would default
   * a balance sheet to yesterday — and on the first of the month, to the previous month.
   */
  return `${year}-${month}-${day}`
}
