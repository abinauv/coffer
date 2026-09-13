/*
 * The units service — one method per method in the `units` group of src/shared/ipc.ts.
 *
 * A thin pass to db/repos/units, and unlike its two neighbours it adds nothing at all.
 * That is worth stating rather than apologising for: a unit of measure is the one master
 * record in these books that the regime has no opinion about. An HSN code is the regime's
 * question and a GSTIN is the regime's question; whether a business counts in `BUNDLE` or
 * in `TIN` is nobody's but theirs. `regime_code` — where the filing layer will later record
 * that `BAGS` reports as `BAG` — is the only place a regime will ever touch this table,
 * and mapping it is Phase 5's job, not a validation on the way in.
 *
 * SO WHY A SERVICE AT ALL, rather than the handler calling the repository. Because the
 * repository takes a `CofferDb` and something has to answer "which company is open" on
 * every call — a cached handle would outlive a `close()` and write into a company the user
 * believes they have shut. `OpenBooks` is that answer, it is shared with every other
 * service, and one service per IPC group (ARCHITECTURE §5) is what keeps it reachable
 * without src/main/ipc ever holding a database handle.
 *
 * A CODE IS AN IDENTITY. Every method that names a unit takes a code, not an id, and the
 * repository normalises it — trimmed and upper-cased — before it touches the database, on
 * reads as well as writes. There is no `rename`: the code is what every item stores and
 * what is printed on every document already issued.
 */

import type { CreateUnitInput, ListUnitsInput, UnitOfMeasure, UpdateUnitInput } from '@shared/dto'
/* `ArchiveUnitInput` belongs beside the others in @shared/dto and is in @shared/ipc
 * because dto.ts was frozen for this batch — see the note above it there. */
import type { ArchiveUnitInput } from '@shared/ipc'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import {
  archiveUnit,
  createUnit,
  deleteUnit,
  getUnit,
  listUnits,
  updateUnit,
} from '../db/repos/units'

export class UnitsService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListUnitsInput = {}): Promise<UnitOfMeasure[]> {
    return listUnits(this.books.db(), input)
  }

  /** Null when there is no such unit. The code is normalised first — `kg` finds `KG`. */
  async get(code: string): Promise<UnitOfMeasure | null> {
    return getUnit(this.books.db(), code)
  }

  async create(input: CreateUnitInput): Promise<UnitOfMeasure> {
    return createUnit(this.books.db(), input)
  }

  /** No code among the fields that may change — it is the identity. See the repository. */
  async update(input: UpdateUnitInput): Promise<UnitOfMeasure> {
    return updateUnit(this.books.db(), input)
  }

  async archive(input: ArchiveUnitInput): Promise<UnitOfMeasure> {
    return archiveUnit(this.books.db(), input.code, input.archived)
  }

  /** Only ever a unit no item is measured in — see the repository. */
  async delete(code: string): Promise<void> {
    return deleteUnit(this.books.db(), code)
  }
}

export function createUnitsService(companies: OpenCompanyHandle): UnitsService {
  return new UnitsService(companies)
}
