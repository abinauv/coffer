/*
 * The numbering service — one method per method in the `numbering` group of
 * src/shared/ipc.ts.
 *
 * A thin pass to db/repos/numbering, with two things worth saying about what is NOT here.
 *
 * THERE IS NO `allocate`. `allocateNumber` exists in the repository and is called from
 * inside the transaction that issues a document or records a receipt, never from a screen:
 * the number this hands out is SPENT, there is no operation that gives one back, and a
 * released number is a gap in a series that rule 46(b) requires to be consecutive. A
 * settings screen that could spend one would be a settings screen that can put a hole in
 * the books by being opened. `preview` is the half that belongs to a screen — the same
 * code path minus the write.
 *
 * `seedDefaults` IS THE REPAIR THE REPOSITORY WAS WAITING FOR, and it is a pass like
 * everything else here precisely because `seedDefaultSeries` was written to have nothing
 * to decide. Its table is total over the numbered kinds and it skips any kind that already
 * has a series, so the repair cannot pick a kind, cannot pick a prefix and cannot move a
 * counter. What it lacked was a caller: it runs from `setUpBooks`, which runs once when a
 * company file is created. So a file made before migration 0012 has no series at all and
 * cannot issue anything, and a file made before 0015 has seven of the nine and can record
 * no refund in either direction — and until this method there was no way to fix either
 * from inside the application. It answers how many it created so a screen can say what it
 * did; zero is the ordinary answer on complete books and is not a failure.
 *
 * WHAT THE SERVICE DOES NOT VALIDATE. Which kinds exist is the domain's closed union and
 * the boundary refuses anything outside it (src/main/ipc/handlers/numbering.ts); which
 * shape fields may still change is the repository's and 0007's trigger underneath it.
 * There is no regime question anywhere in numbering — a series is the business's own
 * format, and the regime's only opinion about a number is `validateDocumentNumber`, asked
 * where a document is issued rather than where a series is configured.
 */

import type {
  CreateNumberingSeriesInput,
  ListNumberingSeriesInput,
  NumberPreview,
  NumberingSeriesRecord,
  UpdateNumberingSeriesInput,
} from '@shared/dto'
/* `ArchiveNumberingSeriesInput` and `PreviewNumberInput` belong beside the others in
 * @shared/dto and are in @shared/ipc because dto.ts was frozen for this batch. */
import type { ArchiveNumberingSeriesInput, PreviewNumberInput } from '@shared/ipc'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import {
  archiveSeries,
  createSeries,
  deleteSeries,
  getSeries,
  listSeries,
  previewNumber,
  seedDefaultSeries,
  updateSeries,
} from '../db/repos/numbering'

export class NumberingService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListNumberingSeriesInput = {}): Promise<NumberingSeriesRecord[]> {
    return listSeries(this.books.db(), input)
  }

  async get(id: string): Promise<NumberingSeriesRecord | null> {
    return getSeries(this.books.db(), id)
  }

  async create(input: CreateNumberingSeriesInput): Promise<NumberingSeriesRecord> {
    return createSeries(this.books.db(), input)
  }

  /** No `kind`: moving a series would renumber what it has already issued. */
  async update(input: UpdateNumberingSeriesInput): Promise<NumberingSeriesRecord> {
    return updateSeries(this.books.db(), input)
  }

  async archive(input: ArchiveNumberingSeriesInput): Promise<NumberingSeriesRecord> {
    return archiveSeries(this.books.db(), input.id, input.archived)
  }

  /** Only ever a series that has never handed out a number — see the repository. */
  async delete(id: string): Promise<void> {
    return deleteSeries(this.books.db(), id)
  }

  /** What the series would produce next. Spends nothing and moves no counter. */
  async preview(input: PreviewNumberInput): Promise<NumberPreview> {
    return previewNumber(this.books.db(), input.seriesId, input.fiscalYearLabel)
  }

  /**
   * Give every numbered kind a series it does not already have.
   *
   * @returns how many were created. Zero on books that are already complete.
   */
  async seedDefaults(): Promise<number> {
    return seedDefaultSeries(this.books.db())
  }
}

export function createNumberingService(companies: OpenCompanyHandle): NumberingService {
  return new NumberingService(companies)
}
