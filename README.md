# Expense Manager for Obsidian

`Expense Manager` is an Obsidian plugin for personal finance tracking inside your vault.

It can work in three modes:
- standalone markdown finance tracker
- finance domain plugin on top of `obsidian-para-core`
- finance layer with Telegram input and reporting when `obsidian-telegram-bot` is installed

The plugin stores every transaction as a note, builds period reports from transactions, keeps balances cumulative across periods, and exposes the same finance context in notes, dashboard widgets, and Telegram.

## What it does

- create finance records for expenses and income
- save receipt images and QR-based transactions
- support proposal-first review flows with `recorded`, `pending-approval`, `needs-attention`, `duplicate`, and `rejected` states
- save manual records directly or keep them as drafts for later review
- build monthly, quarterly, half-year, yearly, and custom reports
- keep report balances cumulative instead of `income - expense` for only one period
- maintain report notes automatically when transactions change
- support budgets on report notes
- sync finance receipts from email and keep source email identity in note frontmatter
- rebuild older email-derived notes from the original email when extraction logic improves
- keep duplicate candidates as explicit notes and merge them through a dedicated Obsidian workflow
- compute budget alerts: `warning`, `forecast`, `critical`
- show monthly finance reports in Telegram with sections, charts, and month navigation
- register finance contributions for PARA projects, areas, dashboard, and Telegram cards when PARA Core is available

## Companion plugins

### Optional but recommended

- `obsidian-para-core`
  - enables finance as a domain plugin
  - stores finance records inside PARA records structure
  - adds dashboard and template contributions
  - enables linked `project` and `area` context

- `obsidian-telegram-bot`
  - enables Telegram input flows
  - enables `/finance_record`, `/finance_summary`, and `/finance_report`
  - enables inline keyboard navigation and PNG charts in Telegram

- `Dataview`
  - renders compact finance report notes from report frontmatter and transaction notes
  - makes transaction rows clickable through `file.link`
  - lets you duplicate a generated report note and turn it into a custom report by editing properties

### Optional for QR enrichment

- [proverkacheka.com](https://proverkacheka.com)
  - used only when QR receipt parsing via external API is enabled
  - local-only QR mode is also supported

## Installation

### Manual install

1. Build the plugin:

```bash
npm install
npm run build
```

2. Copy these files into your vault plugin folder:

```text
<vault>/.obsidian/plugins/expense-manager/
  main.js
  manifest.json
```

3. Enable the plugin in **Settings → Community plugins**.

## Quick start

### 1. Configure the basics

Open **Settings → Expense Manager** and set:
- `Expense folder` if you use the plugin in standalone mode
- `Default currency`
- QR settings if you use receipt parsing
- report automation settings
- budget alert thresholds if you use budgets

When `obsidian-para-core` is installed, storage is managed automatically:
- the `Expense folder` setting is hidden
- transaction notes are stored under `Records/Finance/Transactions/YYYY/MM/`
- receipt artifacts are stored under `Attachments/Finance/YYYY/MM/`

### 2. Add transactions

Use:
- `Add finance record`

The unified command accepts structured finance text, signed amounts, raw receipt QR text, and can switch to receipt image capture from the same flow.
The Obsidian review modal now also lets you:
- choose an explicit transaction date and time
- `Save record` immediately
- `Save as draft` and continue review later from the queue

### 3. Generate reports

Use:
- `Open current month finance report`
- `Save current month finance report`
- `Generate finance report for custom period`

### 4. Migrate old notes if needed

If you already used an older version of the plugin, run:
- `Migrate legacy finance notes`

This updates old finance notes to the current schema.
It also moves legacy flat transaction notes into the dated `YYYY/MM` layout.

## Commands

| Command | What it does |
|---|---|
| `Add finance record` | Create a finance record from text, signed input, QR text, or receipt image |
| `Open finance review queue` | Open the review note for `pending-approval`, `needs-attention`, and `duplicate` finance notes |
| `Open duplicate merge queue` | Open the dedicated Obsidian modal for resolving duplicate finance notes |
| `Sync finance emails` | Run the email finance sync pipeline and create pending-approval notes from provider messages |
| `Rebuild current email transaction` | Re-fetch the source email by saved identity and rebuild the current email-derived transaction note |
| `Sync current finance note filename and folder` | Rebuild the current finance note file name and dated folder placement from its frontmatter |
| `Open current month finance report` | Open the current month report in a modal |
| `Save current month finance report` | Save the current month report note to the vault |
| `Generate finance report for custom period` | Build a report for any date range |
| `Migrate legacy finance notes` | Upgrade old finance notes to the current schema and dated folder layout |

## Telegram workflow

When `obsidian-telegram-bot` is installed and Telegram integration is enabled, the plugin supports:

### Transaction input

```text
/finance_record expense 500 Lunch
/finance_record income 50000 Salary
/finance_record +5000 Cashback
```

You can also add scoped metadata:

```text
/finance_record expense 1200 Taxi | area=Life | project=Trip
```

You can also start an explicit finance capture without inline args:

```text
/finance_record
```

Current Telegram finance intake is `proposal-first`:
- the explicit command opens finance mode
- the next text, QR receipt image, or text-based PDF finance document is parsed into a proposed transaction
- the bot shows `Confirm`, `Save draft`, `Reject`, `Set category`, `Edit date`, `Edit description`, `Set project`, and `Set area`
- the transaction is written to the vault only after `Confirm`
- when the proposal already comes from a saved pending note, Telegram also shows `View note` so you can inspect the current note body and linked artifact before confirming

`/finance_record` is the single transaction intake mode:
- for text, use `expense 500 Lunch`, `income 50000 Salary`, `-500 Lunch`, or `+5000 Bonus`
- for QR receipts, the direction can come from the receipt data itself

Receipt images with QR code are supported in focused capture flows.
Text-based PDF finance documents are supported through local `pdf.js` extraction followed by AI normalization.
Image-only or scanned PDFs are not supported in the current iteration.

### Reporting

```text
/finance_summary
/finance_summary 2026-03

/finance_report
/finance_report 2026-03
/finance_report prev
```

`/finance_report` supports:
- monthly summary
- categories
- top expenses
- projects
- areas
- chart picker
- month navigation

### Telegram charts

Current PNG charts:
- `Expense pie`
- `Year trend`
- `Balance trend`

### Review queue

`/finance_review` now acts as a cross-channel review surface:

- pending and needs-attention items can still be confirmed, edited, rejected, or kept as draft
- duplicate items are visible from Telegram review, but Telegram duplicate handling is intentionally safe and limited
- complex duplicate merge stays Obsidian-first and points you to `Open duplicate merge queue`

## Experimental email intake bridge

The plugin now includes the first end-to-end email intake pipeline:

- manual sync command
- coarse include/exclude filtering
- message planning into text, image, and PDF intake units
- creation of `pending-approval`, `needs-attention`, and `duplicate` finance notes

Current provider option:

- `IMAP (login + app password)`
- `HTTP JSON bridge`

IMAP setup in plugin settings:

- `Email finance provider` -> `IMAP (login + app password)`
- `Mailbox scope` -> optional folder name, defaults to `INBOX`
- `Max email messages per sync run` -> caps one run, useful for large initial imports
- `Enable scheduled email sync` -> runs sync automatically while Obsidian stays open
- `Email sync interval (minutes)` -> polling interval for scheduled sync
- `Telegram notifications for new email receipts` -> sends a Telegram message when sync creates new pending review items
- `IMAP host` -> for example `imap.gmail.com`
- `IMAP port` -> usually `993`
- `IMAP secure connection` -> keep enabled for direct TLS IMAP
- `IMAP username` -> mailbox login
- `IMAP app password` -> provider-specific application password

Current IMAP behavior:

- fetches messages newer than the last successful sync boundary
- for large backfills, processes only the configured maximum number of emails per run
- resumes from the saved cursor on the next run until the backlog is exhausted
- opens the selected mailbox in read-only mode
- extracts `text/plain`, `text/html`, and attachment parts
- supports attachment fan-out into receipt/PDF routes
- does not mark messages as seen or move them between folders

Expected endpoint shape:

- `GET <base-url>/messages`
- optional query params:
  - `since`
  - `cursor`
  - `limit`
  - `mailboxScope`
- optional `Authorization: Bearer <token>` header

Expected JSON response shape:

```json
{
  "messages": [
    {
      "id": "msg-1",
      "threadId": "thread-1",
      "from": "shop@example.com",
      "subject": "Your receipt",
      "receivedAt": "2026-04-04T10:15:00.000Z",
      "textBody": "Payment received...",
      "htmlBody": "<p>Payment received...</p>",
      "attachmentNames": ["receipt.pdf"],
      "attachments": [
        {
          "id": "att-1",
          "fileName": "receipt.pdf",
          "mimeType": "application/pdf",
          "contentBase64": "JVBERi0xLjQK..."
        }
      ]
    }
  ],
  "nextCursor": "cursor-2"
}
```

Current behavior:

- image attachments go through the receipt route
- PDF attachments go through the PDF AI route
- text-only emails go through the text AI route
- created notes persist stable email identity in frontmatter:
  - `email_msg_id`
  - `email_provider`
  - `email_mailbox_scope`
- created notes are saved with status `pending-approval`, `needs-attention`, or `duplicate` depending on extraction and duplicate checks
- pending notes do not affect reports or analytics until approved
- duplicate notes also stay out of analytics until resolved
- receipt date/time extraction is now more robust for:
  - raw HTML markup that carries a timestamp in attributes such as `<time datetime="...">`
  - text-based PDF receipts that expose labeled timestamps or timestamps with seconds
- optional Telegram notifications can announce newly created pending email review items

### Email review ergonomics

Current manual review helpers:

- review pending, needs-attention, and duplicate queues in Obsidian or through `/finance_review`
- open `Open finance review queue` for a note-based queue view inside Obsidian
- open `Open duplicate merge queue` for side-by-side duplicate merge with field-level conflict resolution
- use `Rebuild current email transaction` on an email-derived note to re-fetch the source email and rebuild the note with newer extraction logic
- use `Sync current finance note filename and folder` after editing `dateTime`, type, amount, or description in a saved note
- confirm edited pending notes from Telegram and keep note placement synced with the updated transaction metadata
- use Telegram `View note` on pending proposals to inspect the saved note body and linked artifact before confirming
- rejected review items can either be archived under the transactions root or deleted immediately, depending on plugin settings

## Data model

### Transaction note

Every transaction is stored as a markdown note with frontmatter.

Transaction note placement follows the transaction date:
- standalone mode stores notes under `<Expense folder>/YYYY/MM/`
- `PARA Core` mode stores notes under `Records/Finance/Transactions/YYYY/MM/`

When `PARA Core` mode is active, the standalone `Expense folder` setting is hidden because storage location is owned by the shared PARA domain.

Typical fields:

```yaml
---
type: "finance-expense"
status: "recorded"
dateTime: 2026-03-25T21:30:00.000Z
amount: 1250
currency: "RUB"
description: "Lunch"
category: "Food"
source: "telegram"
project: "[[Projects/Trip]]"
area: "[[Areas/Life]]"
artifact: "[[Attachments/Finance/2026/03/2026-03-25-21-30-00-receipt-1.jpg]]"
tags: ["finance","expense","telegram"]
---
```

The body is intentionally small. It keeps only useful structured additions such as:
- `Items`
- `Artifact`
- `Source Context`

Current lifecycle statuses:

- `recorded`
- `pending-approval`
- `needs-attention`
- `duplicate`
- `rejected`

Additional structured frontmatter used by the current review workflows:

- email-derived notes can store `email_msg_id`, `email_provider`, and `email_mailbox_scope`
- duplicate notes store `duplicate_of` pointing to the original transaction
- rejected notes kept for audit remain excluded from analytics because they use status `rejected`

When `obsidian-para-core` is enabled, receipt artifacts are stored under
`Attachments/Finance/YYYY/MM/` and linked back from the transaction note.
In standalone mode they remain under `<Expense folder>/Artifacts/YYYY/MM/`.
Attachment file names also receive a timestamp prefix like
`2026-03-25-21-30-00-receipt-1.jpg`.
For finance transaction notes and attachments, folder placement and timestamp prefix both use the transaction date.

### Report note

Report notes are generated from transactions and updated by upsert, not recreated blindly.
Their frontmatter remains the source for integrations and budget state, while the note body stays compact and renders live tables through `DataviewJS`.
The `DataviewJS` blocks are intentionally thin: they only resolve the plugin instance and call public rendering methods, while filtering, aggregation, tables, and charts live in the plugin code.

Important frontmatter fields:

```yaml
---
type: "finance-report"
reportOwner: "expense-manager"
reportEngine: "dataviewjs"
reportId: "month-2026-Mar"
reportTemplate: "default"
periodKind: "month"
periodKey: "2026-Mar"
periodLabel: "March 2026"
periodStart: 2026-03-01
periodEnd: 2026-03-31
transactionsRoot: "Records/Finance/Transactions"
filterProject: ""
filterArea: ""
filterTypes: ["expense", "income"]
openingBalance: 18500.00
totalExpenses: 42300.00
totalIncome: 95000.00
netChange: 52700.00
closingBalance: 71200.00
budget: 50000.00
budget_spent: 42300.00
budget_remaining: 7700.00
budget_usage_percentage: 84.60
budget_alert_level: "warning"
---
```

The report note is not treated as source of truth for calculations. Reports are rebuilt from transaction notes.
To create an arbitrary custom report, duplicate a generated report note, change `reportOwner` to `"user"`, assign a new `reportId`, and edit the period or filter properties.

### Dashboard rendering

PARA dashboard contributions now follow the same pattern as report notes:

- the markdown contribution contains a minimal `DataviewJS` host block
- the block calls the public plugin API
- month/year finance widgets, summaries, and charts are rendered by the plugin itself

This keeps dashboard templates compact and avoids large inline rendering scripts in contribution markdown.

## Budgets and budget alerts

Budget is attached to a report note through the `budget` field in frontmatter.

If a report has a budget, the plugin computes:
- spent
- remaining
- usage percentage
- projected month-end spend for the current month
- alert level

Current alert levels:
- `ok`
- `warning`
- `forecast`
- `critical`
- `none`

Settings:
- `Enable budget alerts`
- `Budget warning threshold`
- `Enable budget forecast alerts`
- `Forecast alerts start day`

At the moment budget alerts are shown in reports and Telegram summaries.
The stored `budget_alert_state_*` fields are there to support future proactive Telegram notifications without duplicate spam.

## Automatic reports

The plugin can keep these report types updated automatically:
- monthly
- quarterly
- half-year
- yearly

Expected behavior:
- if a report for a period exists, it is updated
- if it does not exist, it is created
- following periods are recalculated so cumulative balances stay correct
- manual edits to transaction notes are picked up on next sync

## QR receipts

Two QR modes are supported:

- local-only decoding
- API-assisted decoding through `proverkacheka.com`

Receipt artifacts can be stored alongside transactions and linked back from the note.
With `PARA Core`, those artifacts live under `Attachments/Finance/YYYY/MM/` instead of `Records/`.
Transaction notes themselves follow the same date-based layout under
`Records/Finance/Transactions/YYYY/MM/` in PARA mode and `<Expense folder>/YYYY/MM/` in standalone mode.

## PARA Core integration

When `obsidian-para-core` is installed, `Expense Manager` acts as a finance domain plugin.

In this mode, storage is no longer configured through the standalone folder setting. `PARA Core` takes over storage routing, so the `Expense folder` setting is hidden and finance data is written into shared PARA paths.

It registers:
- finance domain
- note types:
  - `finance-expense`
  - `finance-income`
  - `finance-report`
- project and area finance summaries
- template contributions
- dashboard contributions
- Telegram card contributions

This means finance becomes part of the same operational layer as your PARA vault instead of living as an isolated tracker.

## Architecture

Internal service interaction and the updated Telegram finance intake flow are documented in:

- [docs/service-architecture.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/service-architecture.md)
- [docs/email-finance-intake-architecture.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/email-finance-intake-architecture.md)
- [docs/ai-finance-intake-provider.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/ai-finance-intake-provider.md)
- [docs/finance-review-workflow-decision-log.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/finance-review-workflow-decision-log.md)
- [docs/finance-workflow-iteration-summary-2026-04-11.md](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/docs/finance-workflow-iteration-summary-2026-04-11.md)

## Development

### Build

```bash
npm install
npm run build
```

### Dev mode

```bash
npm run dev
```

### VS Code debugging

The repository includes ready-to-use VS Code debug files in [.vscode/launch.json](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/.vscode/launch.json) and [.vscode/tasks.json](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/.vscode/tasks.json).

Recommended flow:

1. Run `Tasks: Run Task` -> `Expense Manager: watch build`
2. After a rebuild, run `Tasks: Run Task` -> `Expense Manager: sync artifacts to para_test_codex_vault`
3. Start `Expense Manager: Attach Obsidian Renderer`

One-click option:

1. Start `Expense Manager: Build, Sync, Launch and Attach`

Notes:

- the debug launch targets `C:\Users\petro\OneDrive\Документы\codex_projects\obsidian\para_test_codex_vault`
- the sync task copies `main.js`, `manifest.json`, and `styles.css` into `para_test_codex_vault/.obsidian/plugins/expense-manager/`
- the launch task starts Obsidian with `--remote-debugging-port=9222`, then opens the vault via `obsidian://open?vault=para_test_codex_vault`
- for reliable attach, fully close other Obsidian windows before using the launch task
- if breakpoints do not bind, make sure Obsidian was launched with `--remote-debugging-port=9222`
- if attach still does not see the renderer target, fully close Obsidian and relaunch it through the VS Code task

### Generate test data

The repository includes a generator for synthetic finance data across the last two years.

Example:

```bash
npm run generate:test-finance-data -- "C:\path\to\test-vault" 800
```

Replace generated notes:

```bash
node scripts/generate-finance-test-data.mjs "C:\path\to\test-vault" 800 --replace-generated
```

Useful options:
- `--months 24`
- `--seed 12345`

## Privacy

- finance notes are stored locally in your vault
- no hidden telemetry
- receipt data is sent to external API only if you enable API-based QR processing
- Telegram integration depends on the separate Telegram plugin and your own bot setup

## Current scope

Already implemented:
- standalone finance tracking
- PARA Core domain integration
- Telegram integration
- manual Obsidian date/time editing and save-as-draft flow
- proposal-first review queue across Obsidian, Telegram, and email intake
- email-derived transaction rebuild from persisted source identity
- explicit duplicate notes with merge workflow in Obsidian
- configurable rejected-item retention policy
- monthly Telegram reports with navigation and PNG charts
- automatic report sync
- cumulative balances
- budget alerts
- legacy note migration

## Startup Sync Policy

`Expense Manager` keeps managed finance reports in sync automatically, but the first sync is intentionally delayed until Obsidian startup is ready for it.

Why:
- existing report files can already exist on disk while the early Vault and metadata indexes are still warming up
- running report upserts too early can produce false `File already exists` conflicts during cold startup

Current policy:
- prefer `app.metadataCache.on('resolved')` as the primary startup signal
- keep a small `onLayoutReady + timeout` fallback in case the initial `resolved` event fired before the plugin subscribed
- run the startup sync only once
- isolate per-report failures so one problematic report cannot fail the whole plugin load

Implementation:
- startup gate: [startup-sync-gate.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/startup-sync-gate.ts)
- report orchestration: [report-sync-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/report-sync-service.ts)

Not implemented yet:
- proactive budget alert push messages in Telegram
- dedicated budget management UX beyond frontmatter editing
- PDF export for Telegram finance reports

## Backlog

Current follow-up ideas after the completed finance workflow iteration:

- suggest or automate file-name and folder sync immediately after manual pending-note edits, so the user does not need to run the sync command separately
- make Telegram pending-note preview richer by splitting note body, source context, and artifact references into clearer sections and eventually deep-linking to the exact note
- add a broader Obsidian-first review workspace that unifies pending, needs-attention, duplicate, and rebuild-oriented actions in one place

## License

MIT
