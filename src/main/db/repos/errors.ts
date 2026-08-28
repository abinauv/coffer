/*
 * Repository-layer errors.
 *
 * The same contract as ../errors.ts: everything below the IPC boundary throws with a
 * stable code, and the boundary translates it into an `AppError` the renderer can
 * branch on (CONVENTIONS §5). `DbError` covers the file — opening it, keying it,
 * migrating it. `RepoError` covers what is written inside it.
 *
 * Codes are shared with `LedgerErrorCode` in domain/ledger where they mean the same
 * thing, so that "you cannot post to a group account" is one code whether the domain
 * or the repository noticed it.
 */

export type RepoErrorCode =
  // ---- Accounts ----
  /** No account with that id. */
  | 'ACCOUNT_NOT_FOUND'
  /** Another account already uses that code. Codes are unique, ignoring case. */
  | 'ACCOUNT_CODE_TAKEN'
  /** The named parent does not exist. */
  | 'ACCOUNT_PARENT_NOT_FOUND'
  /** The named parent is a leaf. Only a group may have children. */
  | 'ACCOUNT_PARENT_NOT_GROUP'
  /** A child must carry its parent's type. */
  | 'ACCOUNT_TYPE_MISMATCH'
  /** The move would make an account a descendant of itself. */
  | 'ACCOUNT_CYCLE'
  /** The account still has children. Move or remove them first. */
  | 'ACCOUNT_HAS_CHILDREN'
  /** A group holds no figures of its own, so it cannot take this. */
  | 'ACCOUNT_IS_GROUP'
  /** The account is archived and accepts nothing new. */
  | 'ACCOUNT_ARCHIVED'
  /** Something references the account — a role mapping, or a posting. */
  | 'ACCOUNT_IN_USE'
  // ---- Roles ----
  /** No account is mapped to that role. */
  | 'ROLE_UNMAPPED'
  // ---- Periods ----
  /** Not a 'YYYY-MM-DD' date. Distinct from `NO_PERIOD`, which is a real date the
   *  books do not reach — the two need different sentences in front of a user. */
  | 'INVALID_DATE'
  /** No period with that id. */
  | 'PERIOD_NOT_FOUND'
  /** No period covers that date. The books do not reach it. Shared with the domain. */
  | 'NO_PERIOD'
  /** The period covering that date is closed or locked. Shared with the domain. */
  | 'PERIOD_CLOSED'
  /** That fiscal year has already been generated. */
  | 'PERIOD_EXISTS'
  /** The span collides with a period the books already have. */
  | 'PERIOD_OVERLAP'
  /** These books are kept in months and the request was quarters, or the reverse. */
  | 'PERIOD_GRANULARITY_MISMATCH'
  /** A period's span never changes — only its status does. */
  | 'PERIOD_IMMUTABLE'
  /** The period is locked. Locked is final; correct it in the current open period. */
  | 'PERIOD_LOCKED'
  /** The transition is not available from the period's current status. */
  | 'PERIOD_STATUS_INVALID'
  /** An earlier period is still open. Periods close in order. */
  | 'PERIOD_EARLIER_OPEN'
  /** A later period is locked, so this one cannot reopen underneath it. */
  | 'PERIOD_LATER_LOCKED'
  // ---- The journal ----
  /** Debits did not equal credits. Shared with the domain. */
  | 'UNBALANCED_ENTRY'
  /** Fewer than two lines. Shared with the domain. */
  | 'INSUFFICIENT_LINES'
  /** A line had both a debit and a credit, or neither. Shared with the domain. */
  | 'AMBIGUOUS_LINE'
  /** A negative debit or credit. Move it to the other side instead. */
  | 'NEGATIVE_AMOUNT'
  /** Not a decimal amount. Malformed input, as distinct from an amount that is wrong. */
  | 'INVALID_AMOUNT'
  /** No entry with that id. */
  | 'ENTRY_NOT_FOUND'
  /** An attempt to modify or delete a posted entry. See invariant 3. */
  | 'ENTRY_IMMUTABLE'
  /** The entry has already been reversed; it cannot be reversed twice. */
  | 'ALREADY_REVERSED'
  /** The entry's date falls outside the period it was assigned to. */
  | 'ENTRY_PERIOD_MISMATCH'
  /** An entry number collided. Sequential per fiscal year, and unique. */
  | 'ENTRY_NUMBER_TAKEN'
  // ---- Parties ----
  /** No party with that id. */
  | 'PARTY_NOT_FOUND'
  /** A party needs a name. */
  | 'PARTY_NAME_REQUIRED'
  /** Another party already uses that name. Names are unique, ignoring case. */
  | 'PARTY_NAME_TAKEN'
  /** Another party already carries that registration number. */
  | 'PARTY_REGISTRATION_TAKEN'
  /** A party must be a customer, a vendor, or both. */
  | 'PARTY_HAS_NO_ROLE'
  /** The party is archived and takes nothing new. */
  | 'PARTY_ARCHIVED'
  /** Something is posted against the party. Archive rather than delete. */
  | 'PARTY_IN_USE'
  /** A line posting to a party control account did not say whose money it is. */
  | 'PARTY_REQUIRED'
  /**
   * The registration number is not one this regime will accept.
   *
   * Raised by the parties service, not by a repository: what a valid GSTIN looks like is
   * the regime's business, and `db/` may not name a concrete regime. It carries a
   * `RepoError` because the code is part of the same vocabulary the party screens branch
   * on, and a second error class reaching the same UI would buy nothing.
   */
  | 'PARTY_REGISTRATION_INVALID'
  /**
   * The registration number encodes a jurisdiction, and it is not the one supplied.
   *
   * Refused rather than silently corrected. A party's jurisdiction decides the place of
   * supply, which decides CGST+SGST against IGST — so the disagreement changes the tax
   * on every invoice raised for them, and whichever value were chosen quietly would be
   * wrong half the time.
   */
  | 'PARTY_JURISDICTION_MISMATCH'
  // ---- Units and items (0006) ----
  /** No unit with that code. */
  | 'UNIT_NOT_FOUND'
  /** A unit with that code already exists, ignoring case. */
  | 'UNIT_CODE_TAKEN'
  /** A unit code with no characters in it. */
  | 'UNIT_CODE_REQUIRED'
  /** An item still uses this unit. Archive it instead. */
  | 'UNIT_IN_USE'
  /** The unit is archived and takes nothing new. */
  | 'UNIT_ARCHIVED'
  /** No item with that id. */
  | 'ITEM_NOT_FOUND'
  /** An item name with no characters in it. */
  | 'ITEM_NAME_REQUIRED'
  /** Another item already has that name, ignoring case. */
  | 'ITEM_NAME_TAKEN'
  /** Another item already has that code, ignoring case. */
  | 'ITEM_CODE_TAKEN'
  /** An item must be sold, purchased, or both. */
  | 'ITEM_HAS_NO_SIDE'
  /** The item is archived and takes nothing new. */
  | 'ITEM_ARCHIVED'
  /** Something references the item — a document line. Archive it instead. */
  | 'ITEM_IN_USE'
  /**
   * The classification code is not one this regime will accept.
   *
   * Raised by the items service, not by a repository: what a valid HSN or SAC looks like
   * is the regime's business and `db/` may not name a concrete regime. Carried as a
   * `RepoError` for the reason `PARTY_REGISTRATION_INVALID` is.
   */
  | 'ITEM_CLASSIFICATION_INVALID'
  /** An item posts to an account that holds no figures of its own. */
  | 'ITEM_ACCOUNT_IS_GROUP'
  // ---- Numbering (0007) ----
  /** No numbering series with that id. */
  | 'SERIES_NOT_FOUND'
  /** No series is configured for that document kind. */
  | 'SERIES_NOT_CONFIGURED'
  /** A series label with no characters in it. */
  | 'SERIES_LABEL_REQUIRED'
  /** Another series for this kind already has that label, ignoring case. */
  | 'SERIES_LABEL_TAKEN'
  /** The width is outside what a sequence may be padded to. */
  | 'SERIES_WIDTH_INVALID'
  /** A series that has handed out a number does not change shape — see 0007. */
  | 'SERIES_IN_USE'
  /**
   * The series is set to include the fiscal year and none was supplied.
   *
   * A number whose year is silently omitted collides with last year's, which rule 46(b)
   * exists to prevent — so it is refused rather than filled in with a guess.
   */
  | 'FISCAL_YEAR_REQUIRED'
  // ---- Documents (0008) ----
  /*
   * These share their names with `DocumentErrorCode` in domain/documents where they mean
   * the same thing, exactly as the ledger codes do — so "this is no longer a draft" is
   * one code whether the domain or the database noticed it.
   */
  /** No document with that id. */
  | 'DOCUMENT_NOT_FOUND'
  /** An edit or a delete against a document that has left draft. Rule 1. */
  | 'DOCUMENT_NOT_DRAFT'
  /** A cancel against a document still in draft. A draft is deleted, not cancelled. */
  | 'DOCUMENT_NOT_ISSUED'
  /** A cancel against a document that has already been cancelled. */
  | 'DOCUMENT_ALREADY_CANCELLED'
  /**
   * A correction names an original it could not have corrected.
   *
   * The wrong party, a draft or cancelled original, a document facing the same way, or a
   * kind that corrects nothing at all — one code for all of them, because 0013 proves
   * them with one `EXISTS` and a sentence naming the specific failure would be a second
   * place the rule is written down.
   */
  | 'DOCUMENT_CORRECTION_INVALID'
  /**
   * A cancel against a document that a live credit or debit note corrects.
   *
   * The same shape as `DOCUMENT_ALLOCATED`: cancelling it would leave the correction
   * adjusting a supply the books say never happened. Cancel the correction first.
   */
  | 'DOCUMENT_CORRECTED'
  /**
   * A due date where there should be none, or none where there should be one (0014).
   *
   * One code for both directions because 0014 proves them with one biconditional — an
   * issued invoice missing its due date is the dangerous half, since it reads to an aged
   * report as a document that is never late and still ties to the control account.
   *
   * Nothing a user does can reach it: `issueDocument` stamps the date and no other path
   * writes the column. It is here because a trigger that can fire has a code, and because
   * a repository bug is exactly what it is watching for.
   */
  | 'DOCUMENT_DUE_DATE_INVALID'
  /** An issue against a document with no lines, or with every line at zero. */
  | 'DOCUMENT_EMPTY'
  /** A quantity, price or discount that is not a decimal string. */
  | 'INVALID_LINE_AMOUNT'
  /** A discount larger than the line it is taken off. */
  | 'DISCOUNT_EXCEEDS_LINE'
  /** A line's stated taxable amount is not what its own figures come to. */
  | 'LINE_TOTAL_MISMATCH'
  /** Two lines claim the same position on one document. */
  | 'DUPLICATE_LINE_NUMBER'
  /** A line names a unit these books do not have. */
  | 'UNIT_UNKNOWN'
  // ---- The company profile (0011) ----
  /** The profile was saved without a legal name. It is what prints on a tax invoice. */
  | 'COMPANY_LEGAL_NAME_REQUIRED'
  /** The profile was saved without a country. */
  | 'COMPANY_COUNTRY_REQUIRED'
  /**
   * The company's own registration number is not one this regime will accept.
   *
   * Raised by the company profile service for the reason `PARTY_REGISTRATION_INVALID` is,
   * and it matters more: a customer with a wrong number changes the tax on that
   * customer's invoices, and the company with a wrong number changes the tax on every
   * invoice in the books.
   */
  | 'COMPANY_REGISTRATION_INVALID'
  /** The company's registration number encodes a jurisdiction, and not the one given. */
  | 'COMPANY_JURISDICTION_MISMATCH'
  /**
   * There is no company profile, and the tax on a supply needs both sides of it.
   *
   * Raised by the documents service. `computeTax` takes a supplier and a customer, and
   * with no profile there is no supplier — not even a country — so there is nothing to
   * compute from. Inventing one would put a jurisdiction of the service's choosing on
   * every invoice in the books, which is the failure nobody would notice.
   */
  | 'COMPANY_PROFILE_MISSING'
  // ---- Receipts and allocations (0012) ----
  /** No receipt with that id. */
  | 'RECEIPT_NOT_FOUND'
  /** A cancel against a receipt that has already been cancelled. */
  | 'RECEIPT_CANCELLED'
  /** A receipt for nothing, or for less than nothing. The direction is the kind. */
  | 'RECEIPT_AMOUNT_INVALID'
  /**
   * The account the money moved through will not take a posting.
   *
   * A group, an archived account, or the control account the other line of the same
   * entry already uses — which would post a receipt against itself and settle nothing.
   */
  | 'RECEIPT_ACCOUNT_INVALID'
  /**
   * The receipt and the document it was allocated to belong to different parties.
   *
   * The worst failure in 0012 and the reason it is a trigger as well as a check: it takes
   * one party's outstanding down because another paid, and nothing anywhere shows it —
   * the control account still totals and the trial balance still ties.
   */
  | 'ALLOCATION_PARTY_MISMATCH'
  /** The allocations against one receipt add up to more than it holds. */
  | 'ALLOCATION_EXCEEDS_RECEIPT'
  /** More was allocated to a document than that document put on the control account. */
  | 'ALLOCATION_EXCEEDS_DOCUMENT'
  /**
   * The voucher does not settle documents of that kind.
   *
   * ONE CODE FOR WHAT READS AS TWO RULES — the wrong side, and the wrong way round — for
   * the reason 0015's trigger is one expression: a voucher settles exactly one document
   * kind, so "a payment cannot settle a sales invoice" and "a refund cannot settle a
   * sales invoice" are the same disagreement. It was `ALLOCATION_SIDE_MISMATCH` until
   * 0015, when a side stopped being enough to name the rule.
   */
  | 'ALLOCATION_KIND_MISMATCH'
  /** An allocation is written and deleted, never edited. See 0012. */
  | 'ALLOCATION_IMMUTABLE'
  /**
   * A cancel against a document that has money allocated to it.
   *
   * Refused rather than detached. The money still exists and still belongs to the party,
   * and silently un-matching it would create on-account money nobody decided to create.
   * Cancelling a RECEIPT is not the same and deletes its allocations — see 0012 for why
   * the two are not symmetrical.
   */
  | 'DOCUMENT_ALLOCATED'
  // ---- Offsets (0016) ----
  /*
   * A SECOND FAMILY RATHER THAN THE `ALLOCATION_*` CODES, and the temptation to reuse
   * them is real: an offset is the same matching row with a document where the voucher
   * was, and every rule below has a counterpart in 0012's set.
   *
   * They are separate because a CODE IS WHAT A SCREEN BRANCHES ON, and the two land on
   * different screens saying different sentences. "Take the allocation off the receipt
   * first" and "take the offset off the credit note first" are two different remedies in
   * two different places, and a screen that could not tell them apart would send a user
   * to look for money that was never involved.
   */
  /** The two documents in an offset belong to different parties. 0012's worst rule, again. */
  | 'OFFSET_PARTY_MISMATCH'
  /**
   * The two documents do not face opposite ways on one side of the trade.
   *
   * One code for what reads as several rules — the wrong side, two charges, two refunds,
   * a quotation, a document set against itself — because 0016 proves them all with one
   * expression, and a sentence naming each would be a second place the rule is written.
   */
  | 'OFFSET_KIND_MISMATCH'
  /** More was offset against a document than it has unsettled. Both ends are capped. */
  | 'OFFSET_EXCEEDS_DOCUMENT'
  /** An offset of nothing, or of something that is not money. */
  | 'OFFSET_AMOUNT_INVALID'
  /** An offset is written and deleted, never edited. See 0016, and 0012 before it. */
  | 'OFFSET_IMMUTABLE'
  /**
   * A cancel against a document standing at either end of an offset.
   *
   * `DOCUMENT_ALLOCATED`'s twin, and it watches both ends rather than one: cancelling
   * either document leaves the offset settling something the books say never happened.
   */
  | 'DOCUMENT_OFFSET'

/** An error raised by a repository. Always carries a stable, machine-readable code. */
export class RepoError extends Error {
  readonly code: RepoErrorCode
  /** Structured context for the message the user eventually sees. Never a path. */
  readonly details: Record<string, unknown>

  constructor(
    code: RepoErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RepoError'
    this.code = code
    this.details = details
  }
}

export function isRepoError(value: unknown): value is RepoError {
  return value instanceof RepoError
}

/**
 * Translate a constraint a database trigger raised into the same error the repository
 * would have produced itself.
 *
 * The repository checks these before writing, so a trigger firing means something got
 * past that check — a concurrent write, or a code path that skipped it. Either way the
 * caller should see the rule that was broken rather than `SQLITE_CONSTRAINT_TRIGGER`.
 */
const TRIGGER_CODES: readonly RepoErrorCode[] = [
  'ACCOUNT_PARENT_NOT_GROUP',
  'ACCOUNT_TYPE_MISMATCH',
  'ACCOUNT_IS_GROUP',
  'PERIOD_OVERLAP',
  'PERIOD_IMMUTABLE',
  'PERIOD_LOCKED',
  'UNBALANCED_ENTRY',
  'INSUFFICIENT_LINES',
  'ENTRY_IMMUTABLE',
  'ENTRY_PERIOD_MISMATCH',
  'PERIOD_CLOSED',
  'ACCOUNT_IN_USE',
  'PARTY_REQUIRED',
  /* Raised by all three of 0007's triggers. They guard one fact from three sides — a
   * series that has handed out a number cannot have that undone — so a counter driven
   * backwards, a counter deleted and a shape changed after issuing all answer with it. */
  'SERIES_IN_USE',
  /* 0008's four triggers, which freeze a document and its lines once it has issued. */
  'DOCUMENT_NOT_DRAFT',
  /* 0013's three, which guard the link a credit note carries to the invoice it corrects
   * — that it points somewhere it could have pointed, and that the thing it points at
   * does not get cancelled out from under it. */
  'DOCUMENT_CORRECTION_INVALID',
  'DOCUMENT_CORRECTED',
  /* 0014's two, which hold the due date to exactly the rows that should have one. */
  'DOCUMENT_DUE_DATE_INVALID',
  /*
   * 0012's six, which guard the one thing an allocation can silently corrupt: a party's
   * statement. `DOCUMENT_NOT_ISSUED` joins the list here rather than with the document
   * codes above, because until 0012 nothing raised it from a trigger — it was a
   * repository refusal only, and a code that no trigger raises has no business in a list
   * of the ones that do.
   */
  'ALLOCATION_PARTY_MISMATCH',
  'ALLOCATION_EXCEEDS_RECEIPT',
  'ALLOCATION_IMMUTABLE',
  /* 0015's, which is 0012's seventh: the document an allocation points at is the one
   * kind its voucher settles. 0012 left this to the repository on the grounds that a
   * wrong pairing was visible; a refund moves the same control account as a receipt, so
   * it stopped being. */
  'ALLOCATION_KIND_MISMATCH',
  'RECEIPT_CANCELLED',
  'DOCUMENT_ALLOCATED',
  'DOCUMENT_NOT_ISSUED',
  /*
   * 0016's four. `DOCUMENT_NOT_ISSUED` is raised by one of them too and is already listed
   * above — an offset against a draft or a cancelled document is the same failure an
   * allocation against one is, and it earns the same sentence.
   */
  'OFFSET_PARTY_MISMATCH',
  'OFFSET_KIND_MISMATCH',
  'OFFSET_IMMUTABLE',
  'DOCUMENT_OFFSET',
]

export function repoErrorFrom(error: unknown, fallback: RepoErrorCode): RepoError {
  if (isRepoError(error)) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const matched = TRIGGER_CODES.find((code) => message.includes(code))
  if (matched !== undefined) {
    return new RepoError(matched, message, {}, { cause: error })
  }
  return new RepoError(fallback, message, {}, { cause: error })
}
