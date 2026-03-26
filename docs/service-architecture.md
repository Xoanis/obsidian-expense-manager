# Expense Manager Service Architecture

This document describes the main runtime interactions inside `obsidian-expense-manager`, with special focus on the updated Telegram finance intake flow.

## Current State

This is the architecture that exists now.

```mermaid
flowchart TD
    U["User"] --> TG["Telegram Bot Plugin"]
    TG --> BR["FinanceTelegramBridgeV2<br/>transport + callbacks + focused input"]
    BR --> FI["FinanceIntakeService<br/>proposal creation boundary"]
    FI --> RP["RuleBasedFinanceIntakeProvider<br/>current extraction implementation"]
    RP --> QR["ProverkaChekaClient<br/>QR / receipt extraction"]
    BR --> ES["ExpenseService<br/>transaction persistence"]
    ES --> VA["Obsidian Vault<br/>transaction notes + artifacts"]
    ES --> PC["PARA Core API<br/>(optional)"]
    ES --> RS["ReportSyncService"]
    RS --> VA
    RS --> TB["TelegramBudgetAlertService"]
    RS --> TC["TelegramChartService"]
    BR --> RS
    BR --> TC
    PC --> VA
```

## Near-Term Future State With AI Provider

This is the intended next step after AI-backed extraction is added, but before the extraction concerns are fully separated into their own dedicated layer.

```mermaid
flowchart TD
    U["User"] --> TG["Telegram Bot Plugin"]
    TG --> BR["FinanceTelegramBridgeV2<br/>transport + callbacks + focused input"]
    BR --> FI["FinanceIntakeService<br/>proposal creation boundary"]
    FI --> AP["AiFinanceIntakeProvider<br/>structured extraction"]
    FI --> RP["RuleBasedFinanceIntakeProvider<br/>fallback / deterministic parsing"]
    AP --> AIP["Shared AI Provider Layer<br/>models + schema validation + retries"]
    AP --> OCR["OCR / document text extraction"]
    RP --> QR["ProverkaChekaClient<br/>QR / receipt extraction"]
    BR --> ES["ExpenseService<br/>transaction persistence"]
    ES --> VA["Obsidian Vault<br/>transaction notes + artifacts"]
    ES --> PC["PARA Core API<br/>(optional)"]
    ES --> RS["ReportSyncService"]
    RS --> VA
    RS --> TB["TelegramBudgetAlertService"]
    RS --> TC["TelegramChartService"]
    BR --> RS
    BR --> TC
    PC --> VA
```

## More Mature Target Architecture

This is a cleaner long-term architecture after provider routing and extraction capabilities are separated more explicitly.

```mermaid
flowchart TD
    U["User"] --> TG["Telegram Bot Plugin"]
    TG --> BR["FinanceTelegramBridgeV2<br/>transport + callbacks + focused input"]
    BR --> FI["FinanceIntakeService<br/>orchestration + routing policy"]
    FI --> ROUTER["Provider Routing Policy"]
    ROUTER --> AP["AiFinanceIntakeProvider"]
    ROUTER --> RP["RuleBasedFinanceIntakeProvider"]
    RP --> QRX["QrReceiptExtractor"]
    AP --> DTX["DocumentTextExtractor"]
    AP --> AIP["Shared AI Provider Layer<br/>models + schema validation + retries"]
    DTX --> OCR["OCR / document extraction capability"]
    BR --> ES["ExpenseService<br/>transaction persistence"]
    ES --> VA["Obsidian Vault<br/>transaction notes + artifacts"]
    ES --> PC["PARA Core API<br/>(optional)"]
    ES --> RS["ReportSyncService"]
    RS --> VA
    RS --> TB["TelegramBudgetAlertService"]
    RS --> TC["TelegramChartService"]
    BR --> RS
    BR --> TC
    PC --> VA
```

## Main Responsibilities

- `FinanceTelegramBridgeV2`
  - owns Telegram v2 transport integration
  - handles commands, callbacks, focused input, and proposal confirmation UX
  - does not own business persistence rules or low-level extraction logic

- `FinanceIntakeService`
  - is the internal boundary for finance intake
  - turns raw Telegram inputs into proposed `TransactionData`
  - is the intended seam for a future AI-backed provider

- `RuleBasedFinanceIntakeProvider`
  - is the current implementation behind `FinanceIntakeService`
  - parses explicit text inputs
  - prepares receipt-based proposals from QR processing
  - can later be replaced or augmented by an `AiFinanceIntakeProvider`

- `ExpenseService`
  - validates linked `project` and `area`
  - attaches artifacts
  - performs duplicate detection
  - persists transactions either directly to the vault or through PARA Core integration

- `ReportSyncService`
  - rebuilds period reports from transactions
  - keeps cumulative balances correct
  - coordinates budget-state-aware report generation

- `TelegramChartService`
  - renders PNG chart outputs for Telegram reports

- `TelegramBudgetAlertService`
  - manages Telegram-oriented budget alert behavior

## Telegram Finance Intake Flow

```mermaid
sequenceDiagram
    participant User
    participant Telegram as Telegram Bot Plugin
    participant Bridge as FinanceTelegramBridgeV2
    participant Intake as FinanceIntakeService
    participant Provider as RuleBasedFinanceIntakeProvider
    participant Expense as ExpenseService
    participant Vault as Obsidian Vault

    User->>Telegram: /expense or /income or /finance_record
    Telegram->>Bridge: command + next focused input
    User->>Telegram: text or QR receipt image
    Telegram->>Bridge: TelegramMessageContext
    Bridge->>Intake: create proposal request
    Intake->>Provider: extract TransactionData
    Provider-->>Intake: proposed transaction
    Intake-->>Bridge: proposal data
    Bridge-->>User: proposal with Confirm / Reject / Set project / Set area
    User->>Bridge: Confirm
    Bridge->>Expense: createTransaction()
    Expense->>Vault: save note + artifact
    Expense-->>Bridge: saved transaction
    Bridge-->>User: success message
```

## Boundary for Future AI Integration

The intended next evolution is:

- keep `FinanceTelegramBridgeV2` as the Telegram-facing UX layer
- keep `ExpenseService` as the persistence and domain-validation layer
- introduce an AI-backed provider behind `FinanceIntakeService`

That keeps responsibilities stable:

- transport stays in Telegram bridge
- extraction stays in intake provider
- persistence stays in expense service

This separation is important because the future `AI provider` should improve proposal quality without forcing a rewrite of Telegram flows or finance storage behavior.

## Evolution Summary

- Current state:
  - `FinanceIntakeService` delegates to a rule-based provider
  - receipt enrichment comes from QR-oriented extraction
  - Telegram owns capture and confirmation UX

- Near-term future state:
  - `FinanceIntakeService` can route to an AI-backed provider
  - AI extraction can use OCR, multimodal understanding, and schema validation
  - rule-based parsing can remain as fallback for deterministic or low-cost paths

- More mature target:
  - `FinanceIntakeService` owns orchestration and routing policy explicitly
  - extraction capabilities are separated from providers
  - QR extraction and document extraction stop being implied as “owned” by one provider
  - AI and deterministic paths share clearer infrastructure boundaries
