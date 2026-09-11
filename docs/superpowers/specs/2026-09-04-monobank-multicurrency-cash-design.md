# Monobank, Multicurrency Reporting, and Cash Ledger Design

## Outcome

Extend the existing private MoneyWave ledger so the current PrivatBank evidence and three local Monobank statements form one autonomous two-year finance view. Every report is expressible in UAH, EUR, or USD without filtering out transactions; movements, FX, fees, and cash remain distinct from terminal spending; one canonical category taxonomy applies across providers.

The analysis window starts on 2024-09-04. Cash opening balances are explicitly zero at that boundary, as confirmed by the requester.

## Approved Data Boundary

- The three Monobank files under `data/monobank/` are authorized for local inspection and import.
- Raw artifacts remain ignored and are stored only inside the local SQLCipher database after import.
- Public FX requests may include currency pairs and dates only. No transaction payload, amount, description, identifier, balance, or derived total leaves the machine.
- For this one-time reconciliation, the requester explicitly authorized transaction questions in the current Codex chat with exact date, amount, description, and relevant account context.
- Credentials, unmasked card/account identifiers, tax identifiers, passport fields, and unrelated raw rows remain excluded unless strictly required.
- Automated Codex categorization retains the narrower existing redaction contract. Chat authorization does not broaden the application's recurring AI data flow.

## Selected Architecture

Use the existing evidence-ledger and make its import boundary provider-generic. Do not bolt Monobank onto PrivatBank-specific branches, and do not replace the application with a new double-entry core in this slice.

The selected design adds four focused capabilities:

1. A Monobank file adapter that understands the observed legacy XLS format and preserves all source semantics.
2. Reproducible per-entry reporting valuations for UAH, EUR, and USD.
3. Evidence-backed cash accounts and cross-provider movement matching.
4. One canonical MCC-aware category taxonomy shared by all personal providers.

## Monobank Import

### Source interpretation

The observed statements have a stable statement-level IBAN and masked-card metadata plus ten transaction columns: timestamp, description, MCC, settlement amount, original amount, original currency, provider rate, fee, cashback, and resulting balance.

- The statement IBAN identifies the account and is stored only as keyed HMAC.
- The masked card identifies an `AccountInstrument`.
- The settlement/card amount is the canonical signed ledger amount.
- The original amount/currency is transaction evidence.
- The provider rate is execution evidence, not the reporting benchmark.
- The fee is explicit provider cost evidence. Structural analysis shows that it is already incorporated into the settlement amount, so it must never create a second debit.
- Cashback is source metadata only. A cashback credit becomes income or a rebate only when a posted balance-affecting row proves the credit.
- The resulting balance creates a statement balance snapshot and participates in continuity checks.
- MCC is normalized as four digits and retained as source metadata for deterministic categorization.

Every row ends in exactly one import state. Balance discontinuities are preserved as reconciliation issues and never repaired by changing source values.

### Provider-generic import boundary

Each adapter exposes a provider descriptor, parser kind/version, discovery strategy, parse/normalize/reconcile functions, and account/instrument registrations. `ImportService` probes an ordered adapter collection instead of branching on two Privat kinds. The repository creates or validates the provider named by the normalized observation and registration.

The normal import UI supports the format, while a protected operator command performs this explicitly authorized one-time import without making ownership guesses reusable product behavior.

## Reporting Valuations

The top-level UAH/EUR/USD control becomes a report-currency selector. Native currency remains an independent transaction filter.

For every posted ledger entry and current balance snapshot:

- preserve the native amount;
- materialize UAH, EUR, and USD equivalents using decimal arithmetic;
- retain requested date, actual publication date, rate, source, and formula version;
- use identity rate `1` only when source and target currencies are identical;
- use the last publication on or before a weekend/holiday transaction date;
- never fall back to `1:1` for a missing non-identity pair;
- exclude missing valuations from converted totals and surface exact coverage warnings.

Rate priority is NBU for pairs involving UAH and ECB for EUR/USD. The other official provider may be used only as a recorded fallback. Historical series are fetched in bounded batches and cached locally. Transaction-provided rates remain visible as executed rates for FX/cost analysis, but they do not make unrelated reporting totals inconsistent.

Converted values are rounded half-up to the target currency's minor units at entry level. Aggregates sum those same stored entry values, ensuring drill-down rows reconcile exactly to charts and totals.

## Movement Graph and Cash

Matching runs across PrivatBank and Monobank after import and valuation:

1. provider/source reference or shared source row;
2. reciprocal owned identifiers;
3. unique account hints with exact amount/currency and compatible time;
4. unique exact cross-provider transfer signal;
5. unique near-amount transfer with an explicit conservation gap;
6. unique cross-currency pair whose executed rate is plausible against the official benchmark.

Global one-to-one assignment remains mandatory. Amount/date alone cannot resolve a non-unique collision. Unmatched foreign transfers stay `external transfer awaiting counterpart evidence`, not spending. Later Wise, Revolut, or Erste evidence attaches to the existing movement rather than creating a second economic event.

Cash is represented as a real local account per evidenced currency:

- opening balance is zero on 2024-09-04;
- a proven ATM/cash withdrawal is a bank debit plus cash credit, not spending;
- a proven cash deposit is cash debit plus bank credit;
- provider fees remain cost components;
- absent manual cash purchases, withdrawn money remains in the cash position;
- manual records may later add cash expenses or exchanges with explicit provenance.

The current Monobank exports contain no MCC 6010/6011 withdrawal rows, so no Monobank cash leg is fabricated.

## Canonical Categories

MoneyWave owns one clean taxonomy. Provider labels and the requester's future spreadsheet labels are evidence/aliases, never competing canonical trees.

Classification priority:

1. explicit manual assignment;
2. persistent user/alias rule;
3. movement, FX, fee, cashback, and cash semantics;
4. MCC rule;
5. provider/source label;
6. merchant heuristic;
7. narrowly sanitized Codex categorization;
8. `other` with recorded provenance.

Transfers, owner draws, FX legs, and cash withdrawals are excluded from spending categories. Existing Privat assignments are recalculated under the same versioned rules as Monobank. Historical assignments remain auditable rather than silently overwritten.

## User Experience

- Overview, charts, accounts, and categories show all currencies converted to the selected report currency.
- Transactions show selected-report value as the primary amount and native value alongside it. The drawer shows all three equivalents, official rate evidence, executed bank rate when present, fee composition, MCC, provider, and linked movement.
- The native-currency filter stays available but is clearly separate from the report-currency selector.
- Money Flow stitches confirmed movement groups into routes without inventing FIFO attribution through pooled accounts.
- Cash receives its own balance row and flow node.
- Data shows import coverage, valuation coverage, and unresolved evidence boundaries.
- No permanent manual Review queue is added. After autonomous analysis, only material unresolved cases are raised in the Codex chat and applied locally as manual evidence after the requester answers.

## Failure Modes and Controls

- **Duplicate import:** reject identical artifact SHA-256; multiset-dedupe overlaps per account.
- **Double-counted fee:** canonical amount remains settlement amount; fee is composition metadata/cost evidence only.
- **Rate drift:** store rate, source, publication date, requested date, and formula version.
- **Weekend gap:** use last official publication on or before the date.
- **Missing rate:** warn and exclude; never invent.
- **False transfer:** require uniqueness and transfer/identifier evidence; ambiguous collisions become questions.
- **False spending:** external transfers and cash movements remain non-terminal.
- **Cash overstatement:** only explicit cash evidence changes the cash ledger; opening balance is an audited manual snapshot.
- **Migration/import damage:** verified encrypted backup before migrations and after each committed artifact, plus integrity and restore checks.
- **Privacy leak:** real-data tooling emits safe result codes; full transaction details appear only in the explicitly authorized interactive questions.

## Acceptance

The slice is accepted only when all three Monobank artifacts are committed to the encrypted local database, every row is partitioned, balance and valuation coverage are explicit, autonomous matching has reached a fixed point, category provenance exists for every eligible terminal expense, UAH/EUR/USD selectors convert instead of filter, cash starts at zero on the approved boundary, and the populated desktop/mobile UI is verified without external application requests beyond allowlisted official rate endpoints.
