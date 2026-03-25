# Expense Manager for Obsidian

`Expense Manager` is an Obsidian plugin for personal finance tracking inside your vault.

It can work in three modes:
- standalone markdown finance tracker
- finance domain plugin on top of `para_core_plugin`
- finance layer with Telegram input and reporting when `obsidian-telegram-bot` is installed

The plugin stores every transaction as a note, builds period reports from transactions, keeps balances cumulative across periods, and exposes the same finance context in notes, dashboard widgets, and Telegram.

## What it does

- create expense and income notes
- save receipt images and QR-based transactions
- build monthly, quarterly, half-year, yearly, and custom reports
- keep report balances cumulative instead of `income - expense` for only one period
- maintain report notes automatically when transactions change
- support budgets on report notes
- compute budget alerts: `warning`, `forecast`, `critical`
- show monthly finance reports in Telegram with sections, charts, and month navigation
- register finance contributions for PARA projects, areas, dashboard, and Telegram cards when PARA Core is available

## Companion plugins

### Optional but recommended

- `para_core_plugin`
  - enables finance as a domain plugin
  - stores finance records inside PARA records structure
  - adds dashboard and template contributions
  - enables linked `project` and `area` context

- `obsidian-telegram-bot`
  - enables Telegram input flows
  - enables `/finance_summary` and `/finance_report`
  - enables inline keyboard navigation and PNG charts in Telegram

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
- `Expense folder`
- `Default currency`
- QR settings if you use receipt parsing
- report automation settings
- budget alert thresholds if you use budgets

### 2. Add transactions

Use one of these commands:
- `Add expense`
- `Add income`
- `Add expense via QR code (receipt)`

### 3. Generate reports

Use:
- `Open current month finance report`
- `Save current month finance report`
- `Generate finance report for custom period`

### 4. Migrate old notes if needed

If you already used an older version of the plugin, run:
- `Migrate legacy finance notes`

This updates old finance notes to the current schema.

## Commands

| Command | What it does |
|---|---|
| `Add expense` | Create an expense note manually |
| `Add income` | Create an income note manually |
| `Add expense via QR code (receipt)` | Parse a receipt image or QR and create a transaction |
| `Open current month finance report` | Open the current month report in a modal |
| `Save current month finance report` | Save the current month report note to the vault |
| `Generate finance report for custom period` | Build a report for any date range |
| `Migrate legacy finance notes` | Upgrade old finance notes to the current schema |

## Telegram workflow

When `obsidian-telegram-bot` is installed and Telegram integration is enabled, the plugin supports:

### Transaction input

```text
/expense 500 Lunch
/income 50000 Salary
```

You can also add scoped metadata:

```text
/expense 1200 Taxi | area=Life | project=Trip
```

And you can send a receipt image with QR code in focused capture flows.

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

## Data model

### Transaction note

Every transaction is stored as a markdown note with frontmatter.

Typical fields:

```yaml
---
type: "finance-expense"
dateTime: 2026-03-25T21:30:00.000Z
amount: 1250
currency: "RUB"
description: "Lunch"
category: "Food"
source: "telegram"
project: "[[Projects/Trip]]"
area: "[[Areas/Life]]"
artifact: "[[Finance/Artifacts/receipt-1.jpg]]"
tags: ["finance","expense","telegram"]
---
```

The body is intentionally small. It keeps only useful structured additions such as:
- `Items`
- `Artifact`

### Report note

Report notes are generated from transactions and updated by upsert, not recreated blindly.

Important frontmatter fields:

```yaml
---
type: "finance-report"
periodKind: "month"
periodKey: "2026-Mar"
periodLabel: "March 2026"
periodStart: 2026-03-01
periodEnd: 2026-03-31
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

## PARA Core integration

When `para_core_plugin` is installed, `Expense Manager` acts as a finance domain plugin.

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
- Telegram v1/v2 compatibility
- monthly Telegram reports with navigation and PNG charts
- automatic report sync
- cumulative balances
- budget alerts
- legacy note migration

Not implemented yet:
- proactive budget alert push messages in Telegram
- dedicated budget management UX beyond frontmatter editing
- PDF export for Telegram finance reports

## License

MIT
