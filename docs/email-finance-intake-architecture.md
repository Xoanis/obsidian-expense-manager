# Email Finance Intake Architecture

This document explains the current email finance intake implementation as code-level diagrams.

The main idea of the current design is:

`mail sync -> coarse filter -> parser chain -> message planning -> finance proposal extraction -> merge -> pending-approval / needs-attention note`

The current implementation supports:

- `IMAP (login + app password)`
- `HTTP JSON bridge`
- manual sync command
- persisted delta-sync boundary
- `pending-approval` transaction notes that stay out of analytics until approval
- `needs-attention` transaction notes for emails that looked finance-related but did not yield a valid proposal

## 1. High-Level Runtime View

```mermaid
flowchart TD
    User["User"]
    Cmd["Command: Sync finance emails"]
    Plugin["ExpenseManagerPlugin"]
    Sync["EmailFinanceSyncService"]
    State["EmailFinanceSyncStateStore"]
    ProviderFactory["createFinanceMailProvider()"]
    Provider["FinanceMailProvider"]
    Filter["EmailFinanceCoarseFilter"]
    ParserChain["CompositeEmailFinanceMessageParser"]
    CustomParsers["Custom Email Parsers"]
    Planner["EmailFinanceMessagePlanner"]
    Intake["FinanceIntakeService"]
    Pending["PendingFinanceProposalService"]
    Expense["ExpenseService"]
    Vault["Obsidian Vault"]
    Reports["Analytics / Reports"]

    User --> Cmd
    Cmd --> Plugin
    Plugin --> Sync
    Sync <--> State
    Sync --> ProviderFactory
    ProviderFactory --> Provider
    Sync --> Filter
    Sync --> Planner
    Planner --> ParserChain
    ParserChain --> CustomParsers
    Sync --> Intake
    Sync --> Pending
    Pending --> Expense
    Expense --> Vault
    Reports --> Expense
```

## 2. End-to-End Sequence

```mermaid
sequenceDiagram
    participant User
    participant Plugin as ExpenseManagerPlugin
    participant Sync as EmailFinanceSyncService
    participant State as EmailFinanceSyncStateStore
    participant Provider as FinanceMailProvider
    participant Filter as EmailFinanceCoarseFilter
    participant Planner as EmailFinanceMessagePlanner
    participant Parsers as Email Parser Chain
    participant Intake as FinanceIntakeService
    participant Pending as PendingFinanceProposalService
    participant Expense as ExpenseService
    participant Vault as Obsidian Vault

    User->>Plugin: Run "Sync finance emails"
    Plugin->>Sync: syncNewMessages()
    Sync->>State: getState()
    Sync->>State: update(lastAttemptAt)
    Sync->>Provider: listMessages(cursor, since, mailboxScope)
    Provider-->>Sync: FinanceMailSyncBatch

    loop each message
        Sync->>Filter: evaluate(message, rules)
        alt filtered out
            Filter-->>Sync: passed = false
        else passed
            Filter-->>Sync: passed = true
            Sync->>Planner: planMessage(message)
            Planner->>Parsers: run specialized parsers
            Parsers-->>Planner: parser units[] or no match
            Planner-->>Sync: planned units[]

            loop each unit
                alt text unit
                    Sync->>Intake: createTextProposal(request)
                    Intake-->>Sync: TransactionData | null
                else receipt unit
                    Sync->>Intake: createReceiptProposal(request)
                    Intake-->>Sync: FinanceReceiptProposalResult
                end

                alt proposal valid
                    Sync->>Pending: createPendingProposal(proposal)
                    Pending->>Expense: createTransaction(status=pending-approval, source=email)
                    Expense->>Vault: write markdown note and optional artifact
                    Vault-->>Expense: TFile
                    Expense-->>Pending: TFile
                    Pending-->>Sync: created
                else invalid / failed
                    Sync-->>Sync: failedUnits += 1
                end
            end
        end
    end

    Sync->>State: update(lastSuccessfulSyncAt, cursor, status, summary)
    Sync-->>Plugin: EmailFinanceSyncSummary
    Plugin-->>User: Notice(summaryText)
```

## 3. Provider Selection

```mermaid
flowchart TD
    A["settings.emailFinanceProvider"] --> B{"Provider kind"}
    B -->|"none"| C["NoopFinanceMailProvider"]
    B -->|"imap"| D["ImapFinanceMailProvider"]
    B -->|"http-json"| E["HttpJsonFinanceMailProvider"]

    C --> F["Return empty batch"]
    D --> G["Fetch live messages from IMAP mailbox"]
    E --> H["Fetch normalized messages from external HTTP bridge"]
```

## 4. IMAP Provider Internals

```mermaid
flowchart TD
    A["ImapFinanceMailProvider.listMessages()"]
    B["Read host / port / secure / user / app password"]
    C{"Missing required credentials?"}
    D["Create ImapFlow client"]
    E["connect()"]
    F["getMailboxLock(mailboxScope or INBOX, readOnly=true)"]
    G["Build search query from since"]
    H["search(..., uid=true)"]
    I["fetch(uid, envelope, internalDate, bodyStructure)"]
    J["collectMessageParts(bodyStructure)"]
    K["downloadMany(text, html, attachments)"]
    L["Normalize message summary"]
    M["Append FinanceMailMessage"]
    N["release mailbox lock"]
    O["logout()"]
    P["Return FinanceMailSyncBatch"]

    A --> B --> C
    C -->|"Yes"| X["Throw configuration error"]
    C -->|"No"| D --> E --> F --> G --> H --> I --> J --> K --> L --> M --> N --> O --> P
```

### IMAP extraction details

```mermaid
flowchart LR
    Root["MessageStructureObject"] --> Walk["Recursive walk over MIME tree"]
    Walk --> Text["Collect text/plain part ids"]
    Walk --> Html["Collect text/html part ids"]
    Walk --> Attach["Collect attachment parts<br/>filename or disposition=attachment"]
    Text --> Download["download() per part"]
    Html --> Download
    Attach --> Download
    Download --> Summary["FinanceMailMessage"]
```

## 5. Coarse Filter Logic

```mermaid
flowchart TD
    A["FinanceMailMessage"] --> B["Enabled rules only"]
    B --> C["Match include rules"]
    B --> D["Match exclude rules"]
    D --> E{"Any exclude match?"}
    E -->|"Yes"| F["Reject message"]
    E -->|"No"| G{"Any include rules configured?"}
    G -->|"No"| H["Pass message"]
    G -->|"Yes"| I{"Matched at least one include?"}
    I -->|"Yes"| H
    I -->|"No"| F
```

Fields that can be matched:

- `from`
- `subject`
- `body`
- `attachmentName`
- `any`

Modes:

- `contains`
- `regex`

## 6. Parser Chain And Message Planning

The planner is no longer only a generic attachment/text router.
It now starts with a parser chain that can short-circuit generic planning for known scenarios.

```mermaid
flowchart TD
    A["FinanceMailMessage"] --> B["CompositeEmailFinanceMessageParser"]
    B --> C["Parser 1: FiscalReceiptFieldsEmailParser"]
    B --> D["Parser N: future vendor-specific parsers"]
    C --> E{"Matched?"}
    D --> F{"Matched?"}
    E -->|"Yes + stop"| G["Return parser-produced units"]
    E -->|"No"| D
    F -->|"Yes + stop"| G
    F -->|"No parser matched"| H["Fallback to generic planner"]
```

Current purpose of the parser layer:

- extract canonical fiscal receipt fields from email body
- support vendor-specific or format-specific parsing without polluting generic planner logic
- leave generic attachments/text fallback in place for everything else

## 7. Generic Planner Fallback

The planner turns one email into zero, one, or many intake units.

```mermaid
flowchart TD
    A["FinanceMailMessage"] --> B["Inspect attachments"]
    B --> C{"Supported attachment?"}
    C -->|"image/* or image extension"| D["Create receipt unit"]
    C -->|"application/pdf or .pdf"| E["Create receipt unit"]
    C -->|"other"| F["Skip attachment"]

    B --> I["Normalize body text"]
    I --> J{"Body or subject available?"}
    J -->|"Yes"| K["Create text unit"]
    J -->|"No"| L["Keep attachment-only units"]
    D --> M["Return combined unit list"]
    E --> M
    K --> M
    F --> M
```

Current rule:

- supported attachments and text body can both produce units for the same email
- duplicate suppression happens after extraction, not at planning time
- this deliberately prefers recall over silence, because missed expenses are worse than duplicate candidates

## 8. Fiscal Receipt Extraction Path

The first specialized parser currently targets receipt-like emails that contain enough fiscal fields in text or HTML to reconstruct the canonical QR payload.

```mermaid
flowchart TD
    A["Email body / HTML / previews"] --> B["FiscalReceiptFieldsEmailParser"]
    B --> C["Extract dateTime"]
    B --> D["Extract amount"]
    B --> E["Extract fn"]
    B --> F["Extract document number i/fd"]
    B --> G["Extract fp/fpd"]
    B --> H["Extract operation type n"]
    C --> I{"All required fiscal fields found?"}
    D --> I
    E --> I
    F --> I
    G --> I
    H --> I
    I -->|"Yes"| J["Build canonical payload<br/>t=...&s=...&fn=...&i=...&fp=...&n=..."]
    I -->|"No"| K["Return no match"]
    J --> L["Planned text unit"]
```

Why this layer exists:

- it turns email receipts into a structured transport payload before AI routing
- it gives us a reusable place for provider-specific parsers
- it lets us preserve fiscal identifiers for dedupe and future enrichment

## 9. Proposal Routing Inside FinanceIntakeService

```mermaid
flowchart TD
    A["Planned unit"] --> B{"Unit kind"}

    B -->|"text"| C["createTextProposal()"]
    B -->|"receipt"| D["createReceiptProposal()"]

    C --> E{"Looks like QR text?"}
    E -->|"Yes"| F["RuleBasedFinanceIntakeProvider"]
    E -->|"No"| G{"AI enabled and text is free-form?"}
    G -->|"Yes"| H["AiFinanceIntakeProvider"]
    G -->|"No"| F

    D --> I{"PDF?"}
    I -->|"Yes"| H
    I -->|"No"| J{"AI receipt mode enabled?"}
    J -->|"Yes"| K["Rule-based first, AI fallback if needed"]
    J -->|"No"| F
```

Important routing nuance:

- raw QR route should trigger only for genuine compact QR payloads
- email bodies that merely contain `fn=...&fp=...` inside a URL or prose should not be treated as raw QR strings

## 10. Pending Proposal Persistence

```mermaid
flowchart TD
    A["Extracted proposals from one email"] --> B{"Equivalent amount/type/time?"}
    B -->|"Yes"| C["Merge proposals"]
    B -->|"No"| D["Keep separate proposals"]
    C --> E["PendingFinanceProposalService"]
    D --> E
    E --> F{"Any valid proposal left?"}
    F -->|"Yes"| G["Write pending-approval note(s)"]
    F -->|"No"| H["Write needs-attention note"]
    G --> I["ExpenseService.createTransaction()"]
    H --> I
    I --> J["Optional artifact persistence"]
    J --> K["Transaction file in vault"]
```

Tag normalization currently removes transport-level leftovers such as:

- `manual`
- `telegram`
- `email`
- `api`
- `pdf`

## 11. Transaction Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending : email sync creates proposal note
    [*] --> NeedsAttention : email passed filter but no valid proposal extracted
    Pending : status = pending-approval
    NeedsAttention : status = needs-attention
    Pending --> Recorded : future approval flow
    Pending --> Deleted : user rejects / deletes note
    NeedsAttention --> Pending : user or future parser resolves candidate
    NeedsAttention --> Deleted : user rejects / deletes note
    Recorded : status = recorded
    Recorded --> Archived : future archive flow
    Archived : status = archived
```

Current reporting rule:

- analytics and reports read `recorded` transactions by default
- duplicate detection checks both `recorded` and `pending-approval`
- `needs-attention` notes stay out of analytics and do not block future real transaction creation

## 12. Sync State Model

```mermaid
flowchart LR
    Settings["settings.emailFinanceSyncState"] --> LastSuccess["lastSuccessfulSyncAt"]
    Settings --> Cursor["cursor"]
    Settings --> LastAttempt["lastAttemptAt"]
    Settings --> Status["lastSyncStatus"]
    Settings --> Summary["lastSyncSummary"]
```

Current usage:

- `lastSuccessfulSyncAt` is used as the delta-sync boundary
- `cursor` is preserved for providers that support cursor-based pagination
- `lastAttemptAt`, `lastSyncStatus`, and `lastSyncSummary` are used for operator visibility in settings

## 13. HTML Receipt Caveat: "QR As Grid"

Some receipt emails do not embed QR as:

- attachment image
- linked PNG/JPEG
- CID inline image

Instead, the QR is rendered directly in HTML as a large grid of black and white blocks.

Architectural implication:

- this should not be treated as a generic image-attachment case
- it should be handled by a dedicated parser when we have enough evidence that the pattern is stable
- for now, the safer general strategy is:
  - prefer extracting fiscal fields from text/HTML
  - preserve HTML links and image sources as context
  - add vendor-specific HTML parsers only when a repeated pattern is confirmed

## 14. Main Entry Points In Code

- [main.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/main.ts)
  - settings UI, command registration, sync service creation
- [sync-finance-emails.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/commands/sync-finance-emails.ts)
  - command wiring
- [email-finance-sync-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/sync/email-finance-sync-service.ts)
  - orchestration
- [finance-mail-provider.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/transport/finance-mail-provider.ts)
  - provider abstraction plus IMAP and HTTP implementations
- [email-finance-coarse-filter.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/sync/email-finance-coarse-filter.ts)
  - pre-routing message filtering
- [email-finance-message-planner.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/planning/email-finance-message-planner.ts)
  - parser-first planning plus generic fan-out into intake units
- [email-finance-message-parsers.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/parsers/email-finance-message-parsers.ts)
  - parser registry, parser contracts, and fiscal receipt extraction
- [finance-intake-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/finance-intake-service.ts)
  - proposal extraction routing
- [pending-finance-proposal-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/email-finance/review/pending-finance-proposal-service.ts)
  - conversion from proposal to pending transaction note
- [expense-service.ts](C:/Users/petro/OneDrive/Документы/codex_projects/obsidian/obsidian-expense-manager/src/services/expense-service.ts)
  - persistence, duplicate checks, transaction reads

## 15. Recommended File Split

The current code works, but email intake is now large enough that keeping every piece under `src/services/` will get noisy.

Recommended future split:

```mermaid
flowchart TD
    Root["src/"]
    Root --> Email["email-finance/"]
    Email --> Transport["transport/"]
    Email --> Sync["sync/"]
    Email --> Parsers["parsers/"]
    Email --> Planning["planning/"]
    Email --> Review["review/"]
    Email --> Types["types/"]
```

Suggested mapping:

- `transport/`
  - IMAP provider
  - HTTP bridge provider
  - provider contracts
- `sync/`
  - sync service
  - sync state store
  - coarse filter
- `parsers/`
  - parser contracts
  - parser registry
  - fiscal field parser
  - future Yandex/vendor parsers
  - future HTML QR-grid parser
- `planning/`
  - generic message planner
  - planner unit types
- `review/`
  - pending proposal persistence
  - later approval/rejection transitions
- `types/`
  - email message summary and parser/planner shared types

Practical recommendation:

- keep cross-domain generic pieces in `services/`
- move email-intake-specific pieces into a dedicated feature folder once the next parser or approval flow lands
- do not move `FinanceIntakeService` or `ExpenseService`, because they are still shared application services rather than email-only internals

## 16. Known Gaps In The Current Design

- no scheduler yet, only manual sync
- IMAP provider does not yet mark messages as processed server-side
- parser registry is still small; only the fiscal field parser exists today
- vendor-specific receipt link parsers are not implemented yet
- HTML QR-grid rendering is not parsed as a first-class receipt artifact yet
- merge heuristics are intentionally simple for now: type + currency + amount + near dateTime
- one message can produce many pending notes, but there is not yet a dedicated review UI for them
- Telegram approval flow for `pending-approval` notes is still a future phase
