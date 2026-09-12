# Confirmed category rules

Policy version: `personal-categories-2026-09-v3`. Confirmed by the requester on 2026-09-10–12. These rules apply to new personal entries, automatic reclassification and explicit workspace report refresh. Private entry identities, merchant descriptors and exact corrections belong only in the encrypted local database.

| Input or former category | Result |
| --- | --- |
| Circle Coffee, Coffee Circle, truncated Coffee Circl | Кава |
| Müller / Mueller / Muller; household goods and home purchases | Покупки, техніка, одяг, дім |
| Health, pharmacies, medicine, supplements, beauty and personal care | Здоров’я та краса |
| Other transport, car, fuel, taxi, public transport, parking | Авто |
| Leisure, sport, entertainment, holidays and travel | Відпустки та подорожі |
| Family payments; gifts formerly included in general purchases | Подарунки |
| Unallocated refunds | Інші виплати |
| Other cafés and restaurants | Кафе та ресторани |
| General shopping, electronics, clothes and home purchases | Покупки, техніка, одяг, дім |
| Confirmed own currency purchases | Excluded from spending; exact-entry movement decision |

Merchant matching uses bounded names, supports capitalization and common spelling variants, and does not match unrelated longer names. The old general-purchases key remains an internal identifier to preserve budgets, links and older clients; its visible name omits gifts. Gifts explicitly attached to a trip retain that collection's travel category. A linked refund follows its purchase's category/exclusion; the refund's negative amount is preserved.

The initial September 12 merge added the former home/health/care category to purchases, including manual cash expenses. Both existing effective-month limits are summed; the existing purchases limit was only one component before this merge. Subsequent refreshes preserve the combined limit without adding it again. The subsequent v3 decision separates Health and Beauty again, using retained original medical and personal-care categories. The mixed former home group remains a purchases alias; it cannot identify health rows by itself. Linked refunds follow their purchases. Existing combined limits remain unchanged and no new health limit is invented. The journal retains original cash evidence while readers resolve former category names.

The explicitly requested merchant capture uses the existing encrypted `category_aliases` table. It remembers exact normalized bank descriptions per provider for purchases and health/beauty, using base categories so a trip attachment does not redefine a merchant. A descriptor found in multiple base categories is skipped and any alias owned by this capture is disabled. A changed unambiguous category updates an owned alias; independently defined conflicting rules are preserved. Case and whitespace variants match; unseen descriptions are not assumed to be the same shop. Existing bounded merchant rules still cover their spelling variants. Do not copy the private merchant inventory to source code, worklogs or shared memory.

## Currency purchases

Source-proven own transfers and FX remain non-spending movements. The requester-confirmed currency purchases, including the previously reviewed EUR 950–990 payments, are stored as exact ledger-entry rules. **There is no amount-only FX rule.** A new payment in that range remains an expense unless its own evidence or an explicit decision establishes otherwise. Exclusion does not invent a matching leg, account ownership, cash balance, exchange rate or fee.

## Persistence and precedence

- The shared domain policy supplies canonical category codes, report groups and merchant rules. Existing automatic assignments, including the prior v1 and v2 policies, are consolidated with a versioned `user_rule` assignment and audit event; prior assignments remain available.
- Core manual assignments and independently defined user rules retain precedence. The optional workspace adapter saves current confirmed row categories, trip attachments and exact FX exclusions in the existing encrypted `categorization_rules` table. Explicit custom workspace categories are retained too. Processing remains usable without an initialized website.
- `refreshDerivedState` synchronizes current workspace decisions before processing. The autonomous category service consumes the rules and applies canonical mappings to new entries. Automatic fallback receives canonical category choices; it cannot supersede confirmed/manual categories. Unknown merchants may still require the existing approved categorization fallback.
- Refreshing a report normalizes incoming groups and sums merged budget baselines once. Effective-month budget edits, category aliases, exact corrections, collection memberships and notes survive. Refresh rejects missing rows referenced by saved edits. New linked refunds inherit the purchase correction.
- An explicit subsequent row correction replaces the corresponding saved decision on the next processing run. Proven movement links retain their financial semantics. Non-FX report exclusions do not establish ownership or create a ledger movement.
- Source statements, imported amounts, dates, identities and evidence remain immutable. Policy assignments and movement exclusion classifications are derived changes. Applying rules to a live ledger requires the normal verified backup and report-refresh workflow; reading the site performs no reprocessing.

## Related interface decisions

Budget defaults to descending actual spending. Navigation preserves page, period, filters and drill-down context through Back/Forward. Year-to-year comparison has a separate block with calendar-year and trailing-12-month modes. These interface choices do not alter categorization or ledger amounts.

## Verification contract

Synthetic coverage checks merchant boundaries, movement precedence, manual overrides, FX reversal, new imports, linked refunds, merged budgets and repeated refresh. Protected acceptance replays category preparation/classification twice on an encrypted database copy with AI disabled, reads back exact rules and compares immutable evidence. A live installation of rules is preceded by a verified recoverable backup and followed by a readback; itemized financial evidence stays under ignored `data/exports/` paths.

See [requirements](requirements.md), [architecture](architecture.md), [MW-033](decisions.md#mw-033-confirmed-categories-survive-reprocessing) and [repository policy](../AGENTS.md).
