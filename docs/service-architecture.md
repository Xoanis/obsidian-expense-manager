# Expense Manager Service Architecture

This document describes the current runtime structure of `obsidian-expense-manager` after the finance intake simplification pass.

The main architectural rule for the current iteration is:

`explicit Telegram intent -> proposal creation -> human confirmation -> vault write`

## Current Runtime View

```mermaid
flowchart TD
    U["User"] --> TG["Telegram Bot Plugin"]
    TG --> BR["FinanceTelegramBridgeV2<br/>commands, callbacks, focused input"]
    BR --> FI["FinanceIntakeService<br/>routing + proposal creation"]
    FI --> RP["RuleBasedFinanceIntakeProvider<br/>structured text + QR-first receipts"]
    FI --> AP["AiFinanceIntakeProvider<br/>free-form text + image + text-based PDF normalization"]
    AP --> DX["DocumentExtractionService<br/>pdf.js text extraction only"]
    AP --> AI["AI chat/completions endpoint"]
    RP --> QR["ProverkaChekaClient"]
    BR --> ES["ExpenseService<br/>validation + persistence"]
    ES --> VA["Obsidian Vault"]
    ES --> RS["ReportSyncService"]
    RS --> VA
    RS --> TB["TelegramBudgetAlertService"]
    RS --> TC["TelegramChartService"]
```

## Current Responsibilities

```mermaid
classDiagram
    class FinanceTelegramBridgeV2 {
      +handle commands
      +collect focused input
      +render confirmation UI
      +apply edits
    }

    class FinanceIntakeService {
      +routeTextRequest()
      +routeReceiptRequest()
      +createTextProposal()
      +createReceiptProposal()
    }

    class RuleBasedFinanceIntakeProvider {
      +createTextTransaction()
      +createReceiptTransaction()
    }

    class AiFinanceIntakeProvider {
      +extractText()
      +extractReceipt()
      +extractPdfReceipt()
    }

    class AiFinancePrompting {
      +build prompts
      +build user payloads
      +parse JSON envelopes
    }

    class AiFinanceNormalization {
      +normalize extracted payload
      +resolve description fallback
      +map issues/confidences
    }

    class FinanceIntakeTypes {
      +request/response contracts
      +routing decision
      +provider interface
    }

    class DocumentExtractionService {
      <<interface>>
      +extractPdf()
    }

    class PdfJsDocumentExtractionService {
      +extractPdf()
    }

    class ExpenseService {
      +createTransaction()
      +validate linked context
      +attach artifact
    }

    FinanceTelegramBridgeV2 --> FinanceIntakeService
    FinanceTelegramBridgeV2 --> ExpenseService
    FinanceIntakeService --> RuleBasedFinanceIntakeProvider
    FinanceIntakeService --> AiFinanceIntakeProvider
    FinanceIntakeService --> FinanceIntakeTypes
    AiFinanceIntakeProvider --> DocumentExtractionService
    AiFinanceIntakeProvider --> AiFinancePrompting
    AiFinanceIntakeProvider --> AiFinanceNormalization
    RuleBasedFinanceIntakeProvider --> FinanceIntakeTypes
    AiFinanceIntakeProvider --> FinanceIntakeTypes
    DocumentExtractionService <|.. PdfJsDocumentExtractionService
```

## Intake Paths

### Text

```mermaid
flowchart LR
    A["Focused text input"] --> B{"Simple structured text?"}
    B -->|"Yes"| C["RuleBasedFinanceIntakeProvider"]
    B -->|"No"| D["AiFinanceIntakeProvider"]
    C --> E["Transaction proposal"]
    D --> E
```

### Receipt Image

```mermaid
flowchart LR
    A["Receipt image / screenshot"] --> B["RuleBasedFinanceIntakeProvider"]
    B --> C{"QR / deterministic parse succeeded?"}
    C -->|"Yes"| D["Transaction proposal"]
    C -->|"No"| E["AiFinanceIntakeProvider"]
    E --> D
```

### PDF

```mermaid
flowchart LR
    A["PDF finance document"] --> B["DocumentExtractionService"]
    B --> C{"Usable text layer?"}
    C -->|"Yes"| D["AiFinanceIntakeProvider"]
    C -->|"No"| E["Unsupported PDF result"]
    D --> F["Transaction proposal"]
```

Important current limitation:

- only `text-based PDF` is supported
- scanned, image-only, or otherwise textless PDF is rejected explicitly

## Telegram Finance Flow

```mermaid
sequenceDiagram
    participant User
    participant Telegram as Telegram Bot Plugin
    participant Bridge as FinanceTelegramBridgeV2
    participant Intake as FinanceIntakeService
    participant Provider as Selected Provider
    participant Expense as ExpenseService
    participant Vault as Obsidian Vault

    User->>Telegram: /expense or /income or /finance_record
    Telegram->>Bridge: command + next focused input
    User->>Telegram: text, image, or PDF
    Telegram->>Bridge: TelegramMessageContext
    Bridge->>Intake: create proposal request
    Intake->>Provider: extract TransactionData
    Provider-->>Intake: proposal or explicit failure
    Intake-->>Bridge: proposal data
    Bridge-->>User: Confirm / Reject / Edit description / Edit date / Set category / Set project / Set area
    User->>Bridge: Confirm
    Bridge->>Expense: createTransaction()
    Expense->>Vault: save note + artifact
    Expense-->>Bridge: saved transaction
    Bridge-->>User: success message
```

## Why The Current Shape Is Simpler

The previous iteration experimented with:

- a custom PDF parser fallback
- rendered-page vision fallback for PDF

Those paths were removed from the current design because they increased code size and debugging cost faster than they increased reliability.

The current design prefers:

- one supported PDF strategy
- explicit unsupported results for out-of-scope documents
- simpler logs
- simpler mental model for maintenance

## Current File Split

- [finance-intake-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/finance-intake-service.ts)
  - orchestration only
- [finance-intake-types.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/finance-intake-types.ts)
  - shared intake contracts
- [rule-based-finance-intake-provider.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/rule-based-finance-intake-provider.ts)
  - deterministic text and QR-first logic
- [ai-finance-intake-provider.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/ai-finance-intake-provider.ts)
  - AI-backed extraction flow

## Near-Term Direction

The current architecture is intentionally conservative.

The next evolution should happen only if it is justified by real usage:

- improve AI proposal quality inside the existing boundaries
- keep Telegram confirmation UX as the stable control point
- revisit OCR/scanned-PDF support only as a separate, clearly scoped iteration
