# Finance Workflow Iteration Summary (2026-04-11)

This document summarizes the completed finance workflow iteration that followed the first live mailbox stabilization pass.

Related design record:

- [finance-review-workflow-decision-log.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/finance-review-workflow-decision-log.md)

## Goals

The iteration focused on turning the finance intake flow into a more explicit, review-friendly system across Obsidian, Telegram, and email.

Primary goals:

- keep more operator-visible state instead of silently dropping or deleting review items
- make manual and automated intake flows converge on the same lifecycle model
- preserve enough source metadata to revisit older notes when extraction improves
- keep persistence concerns in `ExpenseService` and move workflow rules into dedicated services

## Delivered User-Facing Changes

### 1. Transaction lifecycle expansion

The transaction workflow now uses explicit review-oriented statuses:

- `recorded`
- `pending-approval`
- `needs-attention`
- `duplicate`
- `rejected`

This makes duplicate candidates and rejected review items visible, queryable, and excluded from analytics by status rather than by hidden rules.

### 2. Better manual capture in Obsidian

The Obsidian finance modal now supports:

- explicit `dateTime` editing
- direct save as `recorded`
- `Save as draft`, which stores the note as `pending-approval`

This removes the old limitation where manual capture forced an immediate confirm-or-reject choice.

### 3. Save-as-draft in Telegram

Telegram proposals now support:

- `Confirm`
- `Save draft`
- `Reject`

This aligns Telegram capture with the same draft-first review flow used in Obsidian.

### 4. Email source identity and rebuild

Email-derived notes now persist source identity in frontmatter:

- `email_msg_id`
- `email_provider`
- `email_mailbox_scope`

This enables the new `Rebuild current email transaction` command, which re-fetches the original email and rebuilds the note with newer extraction logic.

### 5. Duplicate persistence and merge workflow

Duplicate candidates are no longer discarded.

Instead:

- a duplicate note is created with `status: duplicate`
- the note stores `duplicate_of` pointing to the original transaction
- analytics continue to ignore the duplicate note

Duplicate resolution is now Obsidian-first:

- `Open duplicate merge queue` opens a dedicated modal
- the modal compares original values, duplicate values, and the future merged note
- users can choose original, duplicate, or custom values per field
- merge updates the original note, re-syncs file placement if needed, and deletes the duplicate note

Telegram duplicate handling remains intentionally limited to queue visibility and safe handoff to Obsidian.

### 6. Rejected-item retention policy

Rejecting a saved review note is now policy-driven:

- archive with status `rejected`
- or delete immediately

When archiving is enabled, rejected notes are moved to:

- `<transactions-root>/Archive/Rejected/YYYY/MM`

This supports both traceability-oriented and clean-vault workflows.

## Architectural Outcomes

This iteration reinforced the decision to separate persistence from workflow transitions.

Current split:

- `ExpenseService`
  - note parsing, persistence, duplicate creation, file sync, archive helpers
- `DuplicateMergeWorkflowService`
  - duplicate compare/merge orchestration
- `FinanceReviewWorkflowService`
  - reject-policy orchestration

This keeps storage logic stable while letting review workflows evolve more safely.

## Commands And Review Surfaces Added Or Elevated

- `Open finance review queue`
- `Open duplicate merge queue`
- `Rebuild current email transaction`

Review is now available through:

- Obsidian note queue
- Obsidian duplicate merge modal
- Telegram `/finance_review`

## Verification

By the end of the iteration:

- all implemented flows were manually checked during development
- `npm run build` passed
- `npm test` passed
- targeted workflow coverage was added for the rejected-item policy service

## Result

The finance workflow is now substantially more resilient and operator-friendly:

- fewer silent losses
- clearer lifecycle states
- better cross-channel consistency
- better support for future parser improvements
- a safer path for duplicate resolution and review-note retention

## Recommended Next Steps

Potential follow-up directions after this completed iteration:

- unify more review actions in a broader Obsidian-first review workspace
- automate file-name/folder re-sync after manual pending-note edits where safe
- improve Telegram note preview formatting and deep-linking
- continue expanding deterministic email coverage without overloading the review surfaces
