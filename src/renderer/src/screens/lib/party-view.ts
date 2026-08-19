/*
 * Reading a list of parties.
 *
 * Search is done here rather than by the API, for the same reason the chart of accounts
 * filters in the renderer: `parties.list` takes a `search` argument and it exists for the
 * party picker an invoice will need, where the list is long and the screen is a dropdown.
 * A masters screen holds tens to a few hundred rows, and filtering them locally is
 * instant and cannot get out of step with what was typed.
 *
 * WHAT IS SEARCHED, AND WHY THOSE THREE. Name, because that is what anybody types.
 * Registration number, because a GSTIN is what an accountant reconciling a return has in
 * front of them and a name they may not recognise. City, because it is the field that
 * tells two firms called `Sharma Enterprises` apart — which is exactly the case the
 * unique name index forces somebody to resolve, so it is the case this has to serve.
 */

import type { PartyRole, PartySummary } from '@shared/dto'

/**
 * The rows a search should show. An empty query returns everything.
 *
 * The early return is a shortcut and not a rule: every party has a name, and
 * `name.includes('')` is true, so removing it would return the same rows in a new array.
 * A mutation that deletes it survives on purpose. It stays because handing back the
 * original array when nothing was asked for is worth one line.
 */
export function filterParties(
  parties: readonly PartySummary[],
  query: string,
): readonly PartySummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return parties

  return parties.filter((party) =>
    [party.name, party.registrationNumber, party.city].some(
      (field) => field !== null && field.toLowerCase().includes(needle),
    ),
  )
}

/**
 * What a party is, in words.
 *
 * `Both` rather than `Customer and vendor` because it sits in a narrow column beside a
 * name, and because the long form invites reading it as two records rather than one.
 */
export function partyKindLabel(party: Pick<PartySummary, 'isCustomer' | 'isVendor'>): string {
  if (party.isCustomer && party.isVendor) return 'Both'
  if (party.isVendor) return 'Vendor'
  return 'Customer'
}

/**
 * Whether a party would still be listed under `role` after an edit.
 *
 * The Customers screen shows customers. Un-ticking `is a customer` while looking at it
 * therefore makes the party vanish from the list it was edited on, which reads as a
 * delete. The screen says so beforehand; this is the question it asks.
 */
export function leavesList(
  role: PartyRole | null,
  next: Pick<PartySummary, 'isCustomer' | 'isVendor'>,
): boolean {
  if (role === null) return false
  return role === 'customer' ? !next.isCustomer : !next.isVendor
}

/** The heading and copy for each way the screen is entered. */
export interface PartyScreenCopy {
  title: string
  lede: string
  /** The word for one of them, lower case, for use inside a sentence. */
  noun: string
  /** What a new one is called on the button and in the dialog. */
  newLabel: string
  emptyTitle: string
  emptyBody: string
}

export function copyFor(role: PartyRole | null): PartyScreenCopy {
  if (role === 'customer') {
    return {
      title: 'Customers',
      lede: 'Who these books sell to. A customer who also supplies you is one record with both boxes ticked, not two — that is what keeps a set-off honest.',
      noun: 'customer',
      newLabel: 'New customer',
      emptyTitle: 'No customers yet',
      emptyBody: 'Add the first one and an invoice can be raised against them.',
    }
  }
  if (role === 'vendor') {
    return {
      title: 'Vendors',
      lede: 'Who these books buy from. A vendor you also sell to is one record with both boxes ticked, not two — that is what keeps a set-off honest.',
      noun: 'vendor',
      newLabel: 'New vendor',
      emptyTitle: 'No vendors yet',
      emptyBody: 'Add the first one and a bill can be recorded against them.',
    }
  }
  return {
    title: 'Parties',
    lede: 'Everyone these books trade with, on either side. One record per firm, whichever way the money goes.',
    noun: 'party',
    newLabel: 'New party',
    emptyTitle: 'Nobody here yet',
    emptyBody: 'Add a customer or a vendor to begin.',
  }
}
