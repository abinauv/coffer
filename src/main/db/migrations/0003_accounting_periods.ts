/*
 * 0003 — accounting_periods.
 *
 * The spans the books are divided into, and whether each one will still accept a
 * posting. `FiscalPeriod` in domain/time can already tell you the quarters of 2031-32;
 * this table is the part that says whether you may post into one.
 *
 * WHAT THE DATABASE ENFORCES, AND WHY EACH ONE IS HERE RATHER THAN IN A REPOSITORY.
 * The same test as migration 0002: every rule below is one that, if broken, produces a
 * wrong report rather than an exception, which means it would surface weeks later with
 * no way to tell when it started.
 *
 *   - PERIODS DO NOT OVERLAP. This is the load-bearing one. If two periods cover the
 *     same date then an entry's period is a matter of which row was found first, and the
 *     same figure appears in two months' returns — or in neither, depending on how the
 *     report grouped. Overlap is checked in SQL because it is a fact about the whole
 *     table that no single caller can see.
 *
 *     A useful consequence, relied on elsewhere: a company's books have exactly ONE
 *     granularity. Apr 2026 overlaps Q1 2026-27, so a chart that already has months
 *     cannot also have quarters. That is the intended outcome; the repository detects it
 *     first and says so in a sentence.
 *
 *   - A PERIOD'S SPAN NEVER CHANGES. Only `status` and `closed_at` may be updated.
 *     Moving a boundary silently moves every entry already posted either side of it,
 *     and no report would show that the figures had moved. Generate the year you meant
 *     instead; `removeFiscalYear` exists for a year nothing has touched.
 *
 *   - LOCKED IS FINAL. `closed` is the ordinary month end and reopens freely. `locked`
 *     is a filed return or a signed audit and does not reopen — that distinction is the
 *     whole reason there are two states rather than one flag (domain/ledger/types.ts).
 *     Deliberately with no escape hatch: an error found after filing is corrected in the
 *     current open period, which is what an accountant would do anyway and what an
 *     amended return already expects.
 *
 *   - `closed_at` IS SET EXACTLY WHEN THE PERIOD IS NOT OPEN. A closed period with no
 *     closing timestamp, or an open one carrying a stale timestamp, is an audit trail
 *     that quietly disagrees with itself.
 *
 * DATES ARE COMPARED AS TEXT. 'YYYY-MM-DD' sorts correctly as a string, which is what
 * lets the overlap check be a plain `<=`. The length CHECK is therefore load-bearing
 * rather than cosmetic: a date stored in any other shape would compare wrongly and the
 * overlap rule above would silently stop holding.
 */

import type { Migration } from '../migrate'

export const m0003: Migration = {
  id: '0003',
  name: 'accounting_periods',

  up(db) {
    db.exec(
      `CREATE TABLE accounting_periods (
        id TEXT PRIMARY KEY,
        fiscal_year_label TEXT NOT NULL,
        fiscal_year_start_year INTEGER NOT NULL,
        period_index INTEGER NOT NULL,
        granularity TEXT NOT NULL CHECK (granularity IN ('month', 'quarter')),
        label TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'closed', 'locked')),
        closed_at TEXT,
        created_at TEXT NOT NULL,
        CHECK (period_index >= 1),
        CHECK (length(start_date) = 10 AND length(end_date) = 10),
        CHECK (start_date <= end_date),
        CHECK (length(trim(fiscal_year_label)) > 0),
        CHECK (length(trim(label)) > 0),
        CHECK (
          (status = 'open' AND closed_at IS NULL)
          OR (status <> 'open' AND closed_at IS NOT NULL)
        )
      ) STRICT`,
    )

    /* One period 3 of the 2026 month-books, not two. The overlap trigger would catch a
     * duplicate as well, but a unique index says which of the two facts was violated. */
    db.exec(
      `CREATE UNIQUE INDEX accounting_periods_slot
       ON accounting_periods (fiscal_year_start_year, granularity, period_index)`,
    )
    db.exec(`CREATE INDEX accounting_periods_span ON accounting_periods (start_date, end_date)`)

    /* Two spans overlap when each starts on or before the other ends. Written that way
     * round — rather than as three "starts inside / ends inside / encloses" cases —
     * because the single comparison cannot miss one of them. */
    db.exec(
      `CREATE TRIGGER accounting_periods_no_overlap
       BEFORE INSERT ON accounting_periods
       WHEN EXISTS (
         SELECT 1 FROM accounting_periods
         WHERE NEW.start_date <= end_date AND NEW.end_date >= start_date
       )
       BEGIN
         SELECT RAISE(ABORT, 'PERIOD_OVERLAP');
       END`,
    )

    /* Everything except status and closed_at. `UPDATE OF` fires when a column is named
     * in the SET clause at all, so writing the same value back is refused too — which is
     * what stops a well-meaning "just re-save the row" from being the way a boundary
     * moves. */
    db.exec(
      `CREATE TRIGGER accounting_periods_span_is_fixed
       BEFORE UPDATE OF
         id, fiscal_year_label, fiscal_year_start_year, period_index,
         granularity, label, start_date, end_date, created_at
       ON accounting_periods
       BEGIN
         SELECT RAISE(ABORT, 'PERIOD_IMMUTABLE');
       END`,
    )

    db.exec(
      `CREATE TRIGGER accounting_periods_locked_is_final
       BEFORE UPDATE ON accounting_periods
       WHEN OLD.status = 'locked' AND NEW.status <> 'locked'
       BEGIN
         SELECT RAISE(ABORT, 'PERIOD_LOCKED');
       END`,
    )

    /* A locked period is not deleted either. Without this, "unlock" would be one DELETE
     * and one INSERT away, and the rule above would be advice rather than a rule. */
    db.exec(
      `CREATE TRIGGER accounting_periods_locked_not_deleted
       BEFORE DELETE ON accounting_periods
       WHEN OLD.status = 'locked'
       BEGIN
         SELECT RAISE(ABORT, 'PERIOD_LOCKED');
       END`,
    )
  },

  down(db) {
    db.exec(`DROP TABLE accounting_periods`)
  },
}
