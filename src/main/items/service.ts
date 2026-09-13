/*
 * The items service — one method per method in the `items` group of src/shared/ipc.ts.
 *
 * Mostly a thin pass to db/repos/items, and deliberately so. What it adds is the one
 * thing the repository is forbidden to know, and that repository's own header names it:
 * whether a classification code is real is the regime's business, `db/` may not import a
 * concrete regime (CONVENTIONS §1.6), and threading a validator down through every
 * repository call would put the seam in the wrong place. So it happens above the
 * repository, on the way in — exactly as the parties service does for a GSTIN.
 *
 * THE SHAPE IS ../books/registration.ts's, NOT THE FUNCTION. A registration number and a
 * classification code are asked of the regime the same way and are stored the same way,
 * but the answers do different work: a registration number DERIVES a jurisdiction, and
 * reconciling that derivation with what the caller supplied is most of what
 * `checkRegistration` is. A classification code derives nothing — an HSN says what a thing
 * is, not where anyone is — so there is no second field to reconcile and no mismatch to
 * refuse. Sharing the function would mean sharing a jurisdiction it has no opinion about.
 *
 * WHAT IS STORED IS THE REGIME'S SPELLING. `8471.30`, `8471 30` and `847130` are one
 * tariff item, and the regime normalises them to the last of the three. Storing what was
 * typed would put a code on a return that no schedule matches — the same reasoning
 * `normalisedValue` carries for a GSTIN, and the reason the regime is asked for the
 * canonical form rather than trusted only to say yes or no.
 *
 * WHAT IS NOT HERE. No stock, no valuation, no price history. What an item is worth is a
 * sum over the stock ledger, and a figure on this service would invite somebody to cache
 * it on the record (invariant 4). And nothing here reads a document: every column on an
 * item is a DEFAULT for a line rather than a lookup the line performs later, so repricing
 * an item cannot reach an invoice already issued.
 */

import type {
  ArchiveItemInput,
  CreateItemInput,
  Item,
  ItemSummary,
  ListItemsInput,
  UpdateItemInput,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import {
  archiveItem,
  createItem,
  deleteItem,
  getItem,
  listItems,
  updateItem,
} from '../db/repos/items'
import { RepoError } from '../db/repos/errors'
import type { TaxRegime } from '../regimes'

/** What `checkClassification` has an opinion about. Both halves optional. */
interface Classification {
  classificationCode?: string | null
}

export class ItemsService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListItemsInput = {}): Promise<ItemSummary[]> {
    return listItems(this.books.db(), input)
  }

  async get(id: string): Promise<Item | null> {
    return getItem(this.books.db(), id)
  }

  async create(input: CreateItemInput): Promise<Item> {
    return createItem(this.books.db(), { ...input, ...this.checkClassification(input) })
  }

  /**
   * A change to an item.
   *
   * The same check as `create`, and with no `'classificationCode' in input` guard in front
   * of it, for the reason the parties service gives for not guarding its registration
   * check: `checkClassification` already answers `{}` for a code that is absent, null or
   * blank, so a guard could only ever agree with it. Two conditions that cannot disagree
   * are one condition and a place for them to drift apart later.
   */
  async update(input: UpdateItemInput): Promise<Item> {
    return updateItem(this.books.db(), { ...input, ...this.checkClassification(input) })
  }

  async archive(input: ArchiveItemInput): Promise<Item> {
    return archiveItem(this.books.db(), input.id, input.archived)
  }

  /** Only ever an item that has never reached a document — see the repository. */
  async delete(id: string): Promise<void> {
    return deleteItem(this.books.db(), id)
  }

  /**
   * Put the classification code to the regime the BOOKS were created under.
   *
   * `this.books.regime()` rather than the build's default, which is the point of the
   * service existing at all: what counts as a valid code is a property of the file. A
   * regime that classifies nothing at all — `classification.code` is null — is a real
   * answer and not an error, and such a regime's `validate` is what decides, not a branch
   * here on whether the scheme looks empty.
   */
  private checkClassification(input: Classification): Classification {
    return checkClassification(this.books.regime(), input)
  }
}

/**
 * The classification code, as the regime spells it, or a refusal.
 *
 * Exported for the test that matters: a code the regime refuses must be refused HERE,
 * before anything is written, and the stored value must be the normalised one.
 *
 * Blank is not a code to check, it is the absence of one. A form with an empty HSN box
 * sends `''`, and putting that to the regime would answer 'Enter an HSN or SAC code.' to
 * somebody who has correctly said the item has none — the same trap `checkRegistration`
 * sidesteps for an unregistered party.
 *
 * The result carries only the field it has an opinion about, so spreading it over an
 * update cannot revive a code the caller left absent.
 */
export function checkClassification(regime: TaxRegime, input: Classification): Classification {
  const code = input.classificationCode
  if (code === undefined || code === null || code.trim() === '') {
    return {}
  }

  const result = regime.classification.validate(code)
  if (!result.isValid) {
    throw new RepoError(
      'ITEM_CLASSIFICATION_INVALID',
      result.message ??
        `${code.trim()} is not a ${regime.classification.label} code these books recognise.`,
      { classificationCode: code.trim() },
    )
  }

  /*
   * The regime's spelling, not the caller's. `validateClassificationCode` strips spaces
   * and dots before it looks at anything, so `8471.30` is VALID and would be stored with
   * its dot in if the caller's spelling were kept — and would then never match the
   * tariff again, on a return that fails at the portal weeks later. A valid result always
   * carries a normalised value; the fallback is for a regime that has not been written
   * yet rather than for this one.
   */
  return { classificationCode: result.normalisedValue ?? code.trim() }
}

export function createItemsService(companies: OpenCompanyHandle): ItemsService {
  return new ItemsService(companies)
}
