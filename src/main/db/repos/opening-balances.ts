/*
 * Opening balances.
 *
 * A company adopting Coffer part-way through its life already has balances, and they
 * have to arrive as a journal entry like everything else — there is no other way into
 * the ledger, and inventing one would be a second posting path with its own bugs.
 *
 * WHY THE INPUT IS A SINGLE SIGNED AMOUNT PER ACCOUNT. The user is copying a trial
 * balance they already have. Asking them for a debit or a credit would make them
 * translate it twice: once from their old system's presentation into sides, and again in
 * their head to check it. `amount` is positive in the account's own normal direction —
 * 50,000 in the bank is '50000.00', and 50,000 owed on a loan is also '50000.00' — and
 * this file does the translation, using the same `NORMAL_BALANCE` table the rest of the
 * ledger reads.
 *
 * WHY THERE IS A SUSPENSE SIDE. The entry must balance, and a real opening trial balance
 * usually does not on the first attempt — a figure is missed, or rounded, or the previous
 * accountant's books never quite tied. The difference goes to `opening-balance-equity`,
 * which is what that role exists for: a visible number that should return to zero once
 * everything is entered. Forcing the user to balance before accepting anything would
 * mean they could not save their work half way through, and they would keep it in a
 * spreadsheet instead.
 */

import { ZERO, parseMoney, type Decimal } from '@main/domain/money'
import { normalBalanceOf, type EntryLineDraft } from '@main/domain/ledger'
import type { PostOpeningBalancesInput, PostingResult } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError } from './errors'
import { postEntry } from './journal'

/**
 * Write the opening balances as one entry.
 *
 * Dated by the caller, and it must fall in an open period — usually the first day the
 * books cover. The entry's source is `opening-balance`, so it is distinguishable from a
 * journal somebody typed and can be found again.
 */
export async function postOpeningBalances(
  db: CofferDb,
  input: PostOpeningBalancesInput,
): Promise<PostingResult> {
  if (input.lines.length === 0) {
    throw new RepoError('INSUFFICIENT_LINES', 'There are no opening balances to post.', {})
  }

  /*
   * One figure per account — except on a control account, where one figure per party is
   * the whole point. A business adopting Coffer is owed 4,50,000 by five customers, and
   * a single opening receivable produces no aged report, allocates against nothing, and
   * disagrees with every statement from day one. So the key is the account AND the
   * party, and a repeated account with no party is still the mistake it always was.
   */
  const seen = new Set<string>()
  for (const line of input.lines) {
    const key = `${line.accountId}#${line.partyId ?? ''}`
    if (seen.has(key)) {
      throw new RepoError(
        'AMBIGUOUS_LINE',
        line.partyId === undefined || line.partyId === null
          ? 'An account appears twice in the opening balances. Combine them into one figure.'
          : 'A party appears twice against one account. Combine them into one figure.',
        { accountId: line.accountId, partyId: line.partyId ?? null },
      )
    }
    seen.add(key)
  }

  const accounts = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'type', 'is_group'])
    .where(
      'id',
      'in',
      input.lines.map((line) => line.accountId),
    )
    .execute()
  const byId = new Map(accounts.map((row) => [row.id, row]))

  const lines: EntryLineDraft[] = []
  let difference: Decimal = ZERO

  for (const [index, line] of input.lines.entries()) {
    const account = byId.get(line.accountId)
    if (account === undefined) {
      throw new RepoError(
        'ACCOUNT_NOT_FOUND',
        'An opening balance names an account that does not exist.',
        {
          accountId: line.accountId,
          lineIndex: index,
        },
      )
    }

    const amount = amountOf(line.amount, index)

    /* A zero opening balance is not an error, it is simply nothing to say. Writing it
     * would produce a both-zero line, which invariant 5 refuses. */
    if (amount.isZero()) {
      continue
    }

    /*
     * Positive in the account's normal direction becomes a debit or a credit here. A
     * NEGATIVE amount is meaningful and kept: an overdrawn bank account is an asset with
     * a credit balance, and refusing it would make an honest opening trial balance
     * impossible to enter.
     */
    const onNormalSide = amount.isPositive()
    const magnitude = amount.abs()
    const debitSide = (normalBalanceOf(account.type) === 'debit') === onNormalSide

    lines.push({
      accountId: account.id,
      debit: debitSide ? magnitude : ZERO,
      credit: debitSide ? ZERO : magnitude,
      narration: 'Opening balance',
      partyId: line.partyId ?? null,
    })
    difference = difference.plus(debitSide ? magnitude : magnitude.negated())
  }

  if (lines.length === 0) {
    throw new RepoError('INSUFFICIENT_LINES', 'Every opening balance was zero.', {})
  }

  /*
   * Whatever is left over goes to opening balance equity. When the trial balance being
   * copied in was complete, this is the owner's capital and lands there correctly; when
   * it was not, it is a visible figure to chase rather than a silent refusal.
   */
  if (!difference.isZero()) {
    const equity = await accountForRole(db, 'opening-balance-equity')
    lines.push({
      accountId: equity,
      debit: difference.isNegative() ? difference.negated() : ZERO,
      credit: difference.isPositive() ? difference : ZERO,
      narration: 'Opening balance equity',
    })
  }

  if (lines.length < 2) {
    /* One account, and it balanced to nothing — which cannot happen, because a single
     * non-zero line always leaves a difference. Reported rather than assumed away. */
    throw new RepoError(
      'INSUFFICIENT_LINES',
      'Opening balances need at least one account with a balance.',
      {},
    )
  }

  return postEntry(db, {
    date: input.date,
    narration: 'Opening balances',
    source: { type: 'opening-balance', id: null, number: null },
    lines,
  })
}

/** Whether the opening balances have already been written, and as which entry. */
export async function openingBalanceEntryId(db: CofferDb): Promise<string | null> {
  const row = await db
    .selectFrom('journal_entries')
    .select('id')
    .where('source_type', '=', 'opening-balance')
    .where('reverses_entry_id', 'is', null)
    .orderBy('entry_date')
    .executeTakeFirst()
  return row?.id ?? null
}

async function accountForRole(db: CofferDb, role: string): Promise<string> {
  const row = await db
    .selectFrom('account_roles')
    .select('account_id')
    .where('role', '=', role)
    .executeTakeFirst()
  if (row === undefined) {
    throw new RepoError(
      'ROLE_UNMAPPED',
      `No account is mapped to ${role}, so this cannot post. Every chart Coffer creates maps one, and no screen can yet, so please report this.`,
      { role },
    )
  }
  return row.account_id
}

function amountOf(text: string, lineIndex: number): Decimal {
  try {
    return parseMoney(text)
  } catch (error) {
    throw new RepoError(
      'INVALID_AMOUNT',
      `Opening balance ${String(lineIndex + 1)}: ${JSON.stringify(text)} is not an amount.`,
      { lineIndex, value: text },
      { cause: error },
    )
  }
}
