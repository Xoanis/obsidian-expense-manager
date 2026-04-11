# Finance review workflow decision log

This document captures accepted decisions for the next finance workflow iteration that follows the live mailbox stabilization pass completed on 2026-04-11.

## 2026-04-11

### Decision 1. Extend the transaction lifecycle model

Accepted:

- keep `recorded`, `pending-approval`, and `needs-attention`
- add `duplicate` as a first-class status for notes that should stay visible but must not affect analytics
- add `rejected` as a first-class terminal status for declined review items
- keep `archived` as a legacy-compatible status during the transition

Why:

- the lifecycle is no longer only `recorded vs pending`
- duplicates and rejected review items need explicit, queryable states
- silent duplicate skipping and immediate deletion make operator review harder

Implications:

- analytics continue to read `recorded` transactions by default
- future duplicate notes and rejected notes stay out of reports by status, not by hidden rules

### Decision 2. Treat `draft` as an action, not a new status

Accepted:

- `draft` means “save this transaction for later review”
- saving as draft creates a normal finance note with status `pending-approval`
- this applies to manual flows in Obsidian and Telegram

Why:

- the existing review queue already understands `pending-approval`
- introducing a separate `draft` status would duplicate queue semantics without adding real value

Implications:

- current review surfaces can be reused
- confirm transitions stay the same: `pending-approval -> recorded`

### Decision 3. Persist email source identity in frontmatter

Accepted:

- save `email_msg_id` in note frontmatter for email-derived finance notes
- also save provider metadata needed for robust rebuild workflows:
  - `email_provider`
  - `email_mailbox_scope` when available

Why:

- source identity should not live only inside `Source Context`
- rebuild and audit workflows need direct structured access to the source email identity

Implications:

- existing notes that only have message identity inside `Source Context` will later need a light migration or fallback parser

### Decision 4. Add explicit email rebuild workflow

Accepted:

- rebuilding an email-derived transaction is an explicit user-invoked workflow
- the workflow will re-fetch the message by saved email identity, re-run planning and extraction, and replace the existing structured transaction content
- note filename and dated folder placement must be re-synced after rebuild

Why:

- improved parsers and extraction heuristics should be reusable on older imported notes
- rebuild should be a deliberate action, not a silent background mutation

Implications:

- provider abstraction needs a “fetch message by id” capability in addition to batch sync
- note replacement must support refreshed artifacts, not only frontmatter/body edits

### Decision 5. Persist duplicates instead of skipping them

Accepted:

- likely duplicates must no longer be discarded immediately
- duplicate candidates will be stored as normal finance notes with:
  - `status: duplicate`
  - `duplicate_of` pointing to the original transaction note

Why:

- missing expenses are worse than visible duplicate candidates
- explicit duplicate notes give the user an auditable, mergeable review surface

Implications:

- duplicate detection must evolve from a boolean/exception path into a richer “duplicate match” result
- duplicate notes must stay out of analytics

### Decision 6. Merge duplicates through a dedicated Obsidian modal

Accepted:

- duplicate merge is an explicit Obsidian-first workflow
- the merge modal compares original values, duplicate values, and the future merged values
- the user can pick per-field values from original, duplicate, or enter custom values
- after merge, the original note is updated and the duplicate note is deleted

Why:

- this is a high-context task that fits Obsidian UI better than a terse chat workflow
- field-level conflict resolution is the safest way to preserve the best data

Implications:

- a dedicated merge service and modal are needed
- merge completion must also re-sync the surviving note path if the date, type, amount, or description changed

### Decision 7. Rejected review items are retained by policy

Accepted:

- rejected items are not deleted unconditionally
- the default behavior becomes configurable:
  - archive rejected notes into a dedicated archive location
  - or delete them immediately
- retained rejected notes use status `rejected`

Why:

- rejected review items can still be useful for audit, debugging, and parser iteration
- some users will prefer a clean vault, others will prefer traceability

Implications:

- the storage layer needs archive-path helpers for transaction notes
- current `archived` handling in legacy flows should later be redirected to the new rejected policy

### Decision 8. Manual Obsidian entry must expose date and time

Accepted:

- the Obsidian finance modal must allow explicit editing of the transaction date and time

Why:

- Telegram review already supports date edits
- manual Obsidian entry currently carries a hidden `dateTime` state without a visible UI control

Implications:

- manual entry UX should become consistent across channels
- note naming and folder placement will continue to derive from the chosen transaction date

### Decision 9. Introduce a dedicated workflow layer above persistence

Accepted:

- `ExpenseService` remains focused on persistence, parsing, storage sync, and reporting
- lifecycle transitions and review workflows should move into a dedicated finance workflow service

Why:

- the next iteration adds more state transitions than a persistence service should own directly
- keeping workflow rules outside `ExpenseService` makes future rebuild, duplicate, merge, and rejection policies easier to maintain

Implications:

- new behavior should prefer orchestration services over adding more branching directly into `main.ts` or `ExpenseService`

### Decision 10. Duplicate merge edits only user-meaningful fields

Accepted:

- duplicate merge UI hides service-managed fields from manual editing
- at minimum this includes:
  - `status`
  - `duplicate_of`
  - `source`
  - `type`
  - `email_msg_id`
  - provider-specific email metadata
- merge completion sets service-managed fields automatically:
  - surviving note becomes `status: recorded`
  - `duplicate_of` is cleared
  - hidden metadata is resolved by workflow rules instead of manual editing

Why:

- service metadata is important, but it is not a good manual merge surface
- users should focus on business data, not storage mechanics

Implications:

- duplicate merge needs a dedicated hidden-metadata merge policy
- the modal should prioritize editable finance fields and structured note sections

### Decision 11. Duplicate merge works on structured note sections, not raw markdown body

Accepted:

- Obsidian duplicate merge compares and merges structured body sections instead of arbitrary raw markdown
- current first-class sections are:
  - `Items`
  - `Artifact`
  - `Source Context`
- the implementation should treat the body format as evolving and preserve unknown top-level sections when possible

Why:

- finance notes currently use structured sections that already map to plugin behavior
- full raw-markdown merge would add a much larger and riskier persistence problem

Implications:

- merge workflow needs generic top-level section parsing/rendering helpers
- future note sections should flow into the merge UI without requiring a full redesign

### Decision 12. Telegram duplicate merge starts as a limited safe-flow

Accepted:

- the full duplicate merge experience is Obsidian-first
- Telegram should initially support queue visibility and only simple duplicate handling where the conflict surface stays small
- complex duplicates with structured body conflicts should continue to be resolved in Obsidian

Why:

- Telegram is useful for triage, but awkward for high-context field-by-field and section-by-section merges
- Obsidian provides much safer visibility for note comparison

Implications:

- the first implementation priority is the Obsidian modal and workflow
- Telegram duplicate merge can be added incrementally without blocking the main merge release

## Planned implementation order

1. Foundation: statuses, metadata fields, frontmatter persistence, validation.
2. Quick UX wins: date/time in Obsidian and save-as-draft in Obsidian and Telegram.
3. Email rebuild foundation: provider fetch-by-id and current-note rebuild workflow.
4. Duplicate persistence: create duplicate notes instead of skipping.
5. Duplicate merge workflow service and Obsidian modal.
6. Telegram duplicate triage helpers.
7. Rejected archive/delete policy and archive storage helpers.
