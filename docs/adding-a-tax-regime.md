# Adding a tax regime

> `TaxRegime` is Coffer's internationalisation seam. This is what a new regime has to
> implement, and what must never leak out of `regimes/`.
>
> India GST (`regimes/in-gst/`) is the only implementation today. It was written to be
> the first of several, not the shape everything else bends around.

---

## 1. The rule

**Adding a second regime must require no change outside its own folder.** If it does,
something has leaked through the interface, and the interface is what needs fixing — not
the new regime.

GST must never appear in `domain/`, in `db/`, or in any screen. Everything true of India
and not of everywhere else lives behind `TaxRegime`: how tax is computed, what a
registration number looks like, how goods are classified, when the financial year starts,
how numbers are grouped, how amounts are said in words, and which returns exist.

The reference project this one is derived from called `computeGst()` straight from its
screens. `src/main/regimes/types.ts` exists to prevent that.

### What enforces it

ESLint, not review. `eslint.config.js` restricts imports of `**/regimes/in-*` across all
of `src/**` except `regimes/` itself:

```
Depend on the TaxRegime interface, not a concrete regime.
Tax logic lives only in regimes/.
```

Both a bare folder import (`@main/regimes/in-gst`) and a deep one are matched — the deep
pattern alone missed the import someone would actually write.

`domain/` is restricted further: no Node built-ins, no `electron`, no `db`, no
`services`, no `ipc`. It stays pure.

## 2. The interface

`src/main/regimes/types.ts`. Verbatim, minus comments:

```ts
export interface TaxRegime {
  readonly id: RegimeId
  readonly label: string

  computeTax(input: TaxComputationInput): TaxComputationResult
  placeOfSupply(supplier: TaxParty, customer: TaxParty): PlaceOfSupply
  validateRegistrationNumber(value: string): ValidationResult
  jurisdictionName(code: string): string | null
  jurisdictions(): ReadonlyArray<{ code: string; name: string }>

  readonly classification: ClassificationScheme
  readonly fiscalYear: FiscalYearRule
  readonly numberFormat: NumberFormatRule

  amountInWords(value: Decimal): string

  readonly filings: ReadonlyArray<FilingDefinition>
}
```

Twelve members. Taken one at a time:

### `id` and `label`

`id` is ISO 3166-1 alpha-2, lower case — `'in'`, `'gb'`, `'ae'`. It is the registry key
and it is **persisted**: a company stores its regime id, so an id that changes breaks
every company using it.

`label` is what a picker shows. `'India — GST'`.

### `computeTax`

The whole point of the interface. In:

```ts
interface TaxComputationInput {
  supplier: TaxParty
  customer: TaxParty
  placeOfSupply: PlaceOfSupply
  lines: TaxableLine[]
  date: string // documents are taxed as of their own date
}
```

Out: per-line components that sum exactly to that line's total tax, plus a summary
aggregated across lines.

Every amount in and out is a `DecimalString`. Never a `number`, at any point, for any
reason. Parse with the primitives in `@main/domain/money`.

**Who calls it.** Exactly one place: `src/main/documents/service.ts`. A screen sends what
the user typed — quantity, price, discount, the rate slab — and that service asks this
method with the company profile as the supplier and the party as the customer, then hands
the answer to the repository to store. `db/` may not name a regime and the renderer may
not compute money, so there is one legal home for the call and the DTOs enforce it:
`CreateDocumentInput` (what a screen sends) has no taxable amount and no components,
and `CreateTaxedDocumentInput` (what the repository takes) requires both.

The reference project called `computeGst()` straight from its screens. That is what this
arrangement exists to prevent.

### `placeOfSupply`

Where a supply is treated as taking place, which is what decides _which_ taxes apply. It
returns a jurisdiction code, a country code, and two booleans: `isIntraJurisdiction` and
`isExport`.

If your regime has no sub-national jurisdictions, return `jurisdictionCode: null` and
`isIntraJurisdiction: true`. The concept not applying is a supported answer.

### `validateRegistrationNumber`

GSTIN, VAT number, EIN, ABN. Returns `{ isValid, message, derivedJurisdictionCode? }`.

The message is phrased for the user and is `null` when valid. If your number format
encodes a jurisdiction, derive it — Indian GSTINs carry the state code in the first two
digits, and a screen that can fill the state in from the number is one field the user
does not have to get right twice.

### `jurisdictionName` and `jurisdictions`

A lookup and a list, for pickers. `jurisdictionName('33')` → `'Tamil Nadu'`.

`jurisdictions()` returns what may be used _today_. India has codes that are retired but
still valid on historical documents — 25 (Daman and Diu) and 28 (the undivided Andhra
Pradesh). Validation must accept them; a picker offering them would be wrong. Keep that
distinction in your own data if your jurisdiction has it.

### `classification`

`{ code, label, validLengths, validate }`. `'HSN'`, `'SAC'`, `'NAICS'`. Set `code: null`
and `validLengths: []` where the regime classifies nothing.

### `taxRates`

The rates your schedules contain, for a picker:

```ts
taxRates(): ReadonlyArray<TaxRateDefinition>   // { ratePct, label, note }
```

**Advisory. Nothing gates on it, and that is deliberate.** `computeTax` reads the rate off
the line and never consults this list, so a rate that is not in it computes exactly as one
that is. Rates change on a tax authority's timetable rather than on a release schedule,
and a bundled list that has gone stale must not stand between a user and an invoice they
are legally required to raise. There is a test in `in-gst/regime.test.ts` that computes
17.5% — not a GST rate and never has been — precisely to hold that open.

Return the whole slab, not just the percentage. A dropdown reading `0 / 0.25 / 1.5 / 3` is
four numbers the user has to already know the meaning of; `Nil`, with _Exempt, nil-rated
and zero-rated supplies_ under it, is the same fact said usefully.

A rate is a **schedule** and a component is the **Act**: `taxComponents()` changes by
amendment and arrives with a release, `taxRates()` changes by notification and belongs in
the compliance pack (ARCHITECTURE §6.6). India keeps them in separate files for that
reason, and a regime that mixes them will find the data half impossible to ship.

### `fiscalYear`

A `FiscalYearRule` from `@main/domain/time`. Built with `createFiscalYearRule`, which
needs an id and a start month and defaults the rest:

```ts
export const aprilToMarch: FiscalYearRule = createFiscalYearRule({
  id: 'april-march',
  startMonth: 4,
})
```

`startDay` defaults to 1 and accepts 1 to 28, so the UK's 6 April year works. The default
label is `'2026'` for a year sitting inside one calendar year and `'2026-27'` for one
spanning two; pass `label` to override it.

`januaryToDecember` is already there for calendar-year regimes. `domain/time` derives
everything else — start and end dates, which year a date falls in, the months and
quarters inside it — for any rule. Do not compute fiscal-year arithmetic in your regime;
supply the rule and let `domain/time` do it.

### `numberFormat`

Data, not a formatter:

```ts
export const INDIA_NUMBER_FORMAT: NumberFormatRule = {
  groupSizes: [3, 2], // 1,23,45,678 — last entry repeats
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'INR',
  currencySymbol: '₹',
}
```

`[3]` gives plain thousands. Formatting is presentation and belongs to the renderer; what
a regime owes it is the grouping, the separators and the currency, so a screen can format
any regime's numbers without knowing which one is loaded.

The renderer gets this — and the jurisdictions, the rates, the components and the
classification scheme — from one IPC method, `regime.describe()`. See **How the screens
see your regime** below for what crosses and what does not.

### `amountInWords`

The amount spelled out as this regime's invoices say it. India leads with the currency
word, which is the Indian tax-invoice convention:

```
1234.50 → 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only'
```

Where a regime words it differently, it words it differently. That is the point of the
adapter.

### `filings`

Declarations only — id, label, frequency, description. Producing the artefacts is a later
phase. What belongs here is the list a compliance calendar can render and a settings
screen can offer, so that a regime declaring its own returns needs no change anywhere
else.

Where the ordinary frequency has a per-company exception — GSTR-1 moves to quarterly
under India's QRMP scheme — name it in the description rather than encoding a second
definition. It is a fact about the taxpayer, not about the return.

### How the screens see your regime

Nothing executable crosses to the renderer. `TaxRegime` stays in main, and one IPC method
hands the screens a plain-data description of it:

```ts
regime.describe(): Promise<Result<RegimeDescription>>
```

`RegimeDescription` (src/shared/dto.ts) carries `id`, `label`, `numberFormat`,
`jurisdictions`, `taxRates`, `taxComponents` and the `classification` scheme. It carries
no methods — not `computeTax`, not `validateRegistrationNumber` — so a screen can draw a
rate picker and a place-of-supply picker and still has no way to work out a tax. That is
CONVENTIONS §1.6 expressed as a data flow rather than as a rule people have to remember,
and `src/main/regime/service.test.ts` asserts the absence by name.

Two things are deliberately **not** in it:

- **Your classification codes.** A pack with a few thousand HSN entries behind a
  type-ahead is a search that takes a term, not a payload to hold in memory. When the item
  master needs one it gets its own method.
- **Anything that changes while a company is open.** The description is fetched once per
  open company and held. The regime is read off the company file and cannot change under
  it, so there is nothing to invalidate.

Add a field to `TaxRegime` and it does **not** appear over IPC until somebody adds it to
`describeRegime` in `src/main/regime/service.ts` and to the DTO. That is the safe
direction to forget in: the renderer gets what the contract promises, never whatever an
adapter happens to expose.

## 3. What a new regime looks like on disk

`in-gst/` is one file per concern, and `regime.ts` is the only place they become a
`TaxRegime`:

```
src/main/regimes/xx-vat/
├── index.ts              exports xxVatRegime, plus what this regime's own screens need
├── regime.ts             assembly only — every method delegates, none has logic
├── tax.ts                computeTax
├── place-of-supply.ts    placeOfSupply
├── <number>.ts           validateRegistrationNumber
├── jurisdictions.ts      the sub-national list, if the regime has one
├── classification.ts     the classification scheme
├── number-format.ts      the NumberFormatRule constant
├── amount-in-words.ts    amountInWords
├── filings.ts            the FilingDefinition list
├── compliance-pack.ts    rates and codes as versioned data — see §5
└── __fixtures__/         golden fixtures. Not optional.
```

`regime.ts` should read like a table of contents:

```ts
export const inGstRegime: TaxRegime = {
  id: 'in',
  label: 'India — GST',

  computeTax,
  placeOfSupply,
  validateRegistrationNumber: validateGstin,
  jurisdictionName,
  jurisdictions,

  classification: indiaClassification,
  fiscalYear: aprilToMarch,
  numberFormat: INDIA_NUMBER_FORMAT,
  amountInWords,
  filings: INDIA_FILINGS,
}
```

If a method there does anything more than delegate, the rule it is doing has escaped the
module that owns it.

## 4. Registering it

One line in `src/main/regimes/index.ts`:

```ts
const REGIMES: ReadonlyMap<RegimeId, TaxRegime> = new Map([
  [inGstRegime.id, inGstRegime],
  [xxVatRegime.id, xxVatRegime],
])
```

That file is the only place outside `regimes/` — and the only place inside it — that
names a concrete regime. Everything above asks by id:

|                      |                                                                       |
| -------------------- | --------------------------------------------------------------------- |
| `getRegime(id)`      | The regime, or throws naming what is installed.                       |
| `findRegime(id)`     | The regime, or `undefined`. Use this when the id came from disk.      |
| `isRegimeId(id)`     | Boolean.                                                              |
| `availableRegimes()` | `{ id, label }[]` for a picker.                                       |
| `DEFAULT_REGIME_ID`  | `'in'` — the only one that exists, not a claim that India is special. |

`findRegime` is the one that matters at open time. A company's regime id comes off disk,
so an id that no longer resolves is a real situation — a downgrade, a hand-edited file —
and it deserves a message about which regimes are installed, not a crash three calls
later.

## 5. Two things India got right that you should copy

### Rates are data; the structure of the Act is code

`compliance-pack.ts` holds rate slabs and classification codes as a versioned data
structure with an `effectiveFrom` date and a `source`. Every consumer takes an
`IndiaCompliancePack` as an argument and defaults to the bundled one, so a future loader
only has to produce a different value of the same type — no call site changes.

Rates change on a government's timetable, not on a release timetable, and an offline tool
quietly running last year's schedule loses the trust that made someone choose it.

What is deliberately **not** in the pack: the CGST/SGST/IGST split, the halving of an
intra-state rate, and the state list. Those are the structure of the Act rather than its
schedules. They change by amendment, which arrives with a release. Putting them in a data
file would let a data file redefine what a tax is.

Draw the same line in your regime.

### Round once, then allocate

The obvious implementation rounds each tax component. India's does not, and the reason
generalises to any regime that splits one rate into parts.

9% of 100.05 is 9.0045 → 9.00, twice, giving 18.00. But 18% of 100.05 is 18.009 → 18.01.
The same supply now has two different tax figures depending on which side of a state line
the customer sits, and neither the invoice nor the return will reconcile with the other.

So: apply the rate **once**, at full precision. Round the line's total tax **once**.
Then _allocate_ that rounded total across the components in proportion to their rates,
using `allocateByWeights` from `@main/domain/money` — a largest-remainder split, so the
components sum to the total exactly, always, and an odd paisa lands deterministically
rather than wherever the arithmetic happened to drop it.

Two invariants follow, and both are pinned in fixtures:

- a line's components sum to its total tax, exactly;
- a line's total tax does not depend on how the tax splits.

Pin the equivalents for your regime.

## 6. What must never leak

|                                      |                                                                     |
| ------------------------------------ | ------------------------------------------------------------------- |
| A tax name outside `regimes/`        | No `cgst`, `vat`, `sgst` in `domain/`, `db/`, `ipc/` or a screen.   |
| A concrete regime import             | ESLint rejects `@main/regimes/in-gst` from anywhere but `regimes/`. |
| A fiscal-year constant               | No "April" anywhere. `domain/time` takes a rule.                    |
| A hardcoded policy dressed as a rule | See below.                                                          |
| A `number` for money                 | Decimal strings at every boundary, `Decimal` in memory.             |

That fourth one deserves a paragraph, because it is the mistake that is hardest to see.

The reference project hardcoded _"freight is never taxed"_ inside its tax function. That
was one client's policy wearing the costume of a rule, and a client with a different
policy had nowhere to put it. In Coffer, `isCharge` on a line says what a line **is** —
freight, packing, insurance — not whether it is taxable. A charge that should not be
taxed arrives with a rate of 0, which is a decision the user can see and change.

When you are about to encode "X is never taxed", ask whether that is the law or a
convention. If it is a convention, it is configuration.

## 7. Tests

`domain/` and `regimes/` carry the coverage thresholds — 90% lines, 90% functions, 85%
branches, enforced by `vitest.config.ts`. That is where correctness lives.

Anything numeric uses **golden fixtures** in `__fixtures__/*.json`, co-located with the
code. India has three: `tax-splits.json`, `gstin.json`, `amount-in-words.json`.

Changing a rounding or tax rule must break a test. If your change cannot break one, it is
not covered. No snapshot tests for anything numeric.

## 8. Before you start

Open an issue first. A regime is not a small change, and it is the one part of the
codebase where the interface is more likely to be wrong than your implementation — if
something does not fit through `TaxRegime`, that is worth discussing before either of us
writes code.

Say which country, which taxes, and one worked example of a document with its tax
correctly computed. The example is worth more than the prose.
