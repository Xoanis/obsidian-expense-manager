# AI Finance Intake Provider Design

This document describes the intended design of `AiFinanceIntakeProvider` for `obsidian-expense-manager`.

The goal is to introduce AI-backed extraction without breaking the boundaries that already exist:

- `FinanceTelegramBridgeV2` owns transport and confirmation UX
- `FinanceIntakeService` owns orchestration and provider routing
- `ExpenseService` owns domain validation, deduplication, artifact attachment, and persistence

## Purpose

`AiFinanceIntakeProvider` should turn raw finance-oriented inputs into a structured finance proposal that is safe enough to present for confirmation.

Typical inputs:

- free-form natural language
- screenshot of a banking operation
- PDF bank confirmation
- image or scan of a receipt without a usable QR code
- mixed text plus file attachment

Typical output:

- a proposed finance transaction
- field-level confidence
- warnings and ambiguities
- provider metadata for traceability

## Goals

- support finance extraction from inputs that are too ambiguous for deterministic parsers
- return structured output instead of plain text reasoning
- provide field-level confidence, not only one global score
- preserve enough metadata for confirmation UX and later debugging
- fit behind `FinanceIntakeService` so Telegram and future UI surfaces do not depend on AI details

## Non-Goals

- direct vault writes
- direct Telegram messaging
- duplicate detection against stored transactions
- final domain validation for `project` and `area`
- automatic routing of arbitrary non-finance inputs to other plugins

Those concerns belong elsewhere:

- persistence and domain validation stay in `ExpenseService`
- confirmation UX stays in `FinanceTelegramBridgeV2`
- broader dispatcher behavior is a later system-level concern

## Provider Responsibility

`AiFinanceIntakeProvider` is responsible for:

- extracting finance-relevant signals from raw artifacts
- deciding whether the input appears finance-related
- producing a structured proposal candidate
- reporting uncertainty explicitly

`AiFinanceIntakeProvider` is not responsible for:

- deciding whether the proposal should be auto-saved
- mutating vault state
- resolving duplicates against existing records
- owning Telegram callback flows

## Routing Model

`FinanceIntakeService` should decide which provider to use through explicit policy.

Recommended near-term policy:

- simple explicit text like `500 Lunch` under `/expense` or `/income` -> `RuleBasedFinanceIntakeProvider`
- files such as image or PDF -> `AiFinanceIntakeProvider`
- free-form text under `/finance_record` -> `AiFinanceIntakeProvider`
- explicit deterministic QR flow can remain rule-based even when AI exists

Recommended later policy:

- move routing rules into a dedicated `FinanceIntakeRoutingPolicy`
- allow `ai-preferred`, `rule-only`, and `hybrid` modes via settings
- support fallback from AI to rule-based when appropriate

## Request Shape

`AiFinanceIntakeProvider` should receive one normalized request object rather than several Telegram-specific primitives.

Recommended request contents:

- intake command and intent
- raw text
- caption text
- artifacts
- locale and time zone
- default currency
- known categories
- known projects
- known areas
- optional account hints later

The provider should not receive Telegram callback state or UI-specific details.

## Result Shape

The provider should return a structured result envelope, not only `TransactionData`.

Recommended result sections:

- `status`
  - `success`
  - `ambiguous`
  - `non_finance`
  - `failed`
- `transaction`
  - proposed normalized transaction fields
- `fieldConfidences`
  - confidence for amount, type, dateTime, description, category, project, area
- `issues`
  - warnings, ambiguities, or extraction problems
- `provider metadata`
  - model id
  - provider kind
  - extraction path

This result should later be translated by `FinanceIntakeService` into the proposal model used by Telegram confirmation UI.

## Confidence Model

Field-level confidence is more useful than a single global score.

Recommended field set:

- `type`
- `amount`
- `currency`
- `dateTime`
- `description`
- `category`
- `project`
- `area`

Recommended confidence scale:

- `0.0` to `1.0`

Recommended interpretation:

- `>= 0.9` strong confidence
- `0.7 - 0.89` acceptable but should still be reviewable
- `< 0.7` likely needs explicit user attention in confirmation UI

The provider may also return an `overallConfidence`, but field confidence should remain primary.

## Extraction Pipeline

Recommended near-term pipeline:

1. Normalize input request.
2. If file-based and needed, call document or OCR extraction capability.
3. Build a schema-constrained AI extraction request.
4. Validate returned JSON against the expected schema.
5. Normalize output into the shared contract model.
6. Attach warnings and confidence values.

The provider should fail closed:

- if structured validation fails, return `failed` or `ambiguous`
- do not silently invent a valid-looking transaction

## Prompting and Validation

Recommended AI behavior:

- ask the model to determine whether the input is finance-related
- ask for a structured result only
- require null or omitted fields when uncertain
- forbid guessing `project` or `area` unless evidence is present
- prefer explicit warnings over fabricated certainty

Recommended validation layers:

- JSON schema validation
- numeric validation for amount
- ISO-compatible date normalization if possible
- enum validation for transaction type and status

## Safe Use of Domain Context

The request may include:

- known categories
- known projects
- known areas

This context should be used as hints, not hard constraints.

Rules:

- the provider may map to an existing category with confidence
- the provider may suggest a project or area only if there is evidence
- if uncertain, it should leave `project` or `area` unset instead of guessing

Final correctness remains the responsibility of:

- confirmation UI
- `ExpenseService`

## Integration Plan

Recommended implementation order:

1. Add shared contracts for AI extraction request and result.
2. Add `AiFinanceIntakeProvider` interface-compatible class with a stubbed implementation.
3. Update `FinanceIntakeService` so routing is explicit and provider-specific.
4. Introduce a document extraction helper for PDF and image text.
5. Wire AI extraction only for file-based and free-form `finance_record` inputs first.

## MVP for AI Provider

The first useful AI-backed slice should support:

- image without QR
- PDF finance document
- free-form finance text in `/finance_record`

The first version should still:

- require confirmation before save
- keep `RuleBasedFinanceIntakeProvider` for simple explicit text
- avoid broad non-finance routing

## Current Validation Notes

After the latest Telegram proposal improvements, the following assumptions now look validated enough to keep:

- free-form text extraction benefits noticeably from known category, project, and area hints
- confirmation-first UX remains the right default even when extraction quality is high
- users need quick correction paths for category, project, area, and date because category remains the weakest field
- local open models can already be useful when the prompt is constrained and the output format is strict
- QR receipt images should stay deterministic-first because clear QR inputs are often handled more reliably by the existing parser than by multimodal chat endpoints

## Near-Term Improvements

The next practical improvements worth keeping in mind are:

- confidence-aware UI hints so weak category guesses are highlighted more explicitly
- routing policy that distinguishes `ai-text`, `ai-image`, `ai-pdf`, and `rule-qr` more explicitly
- capability-aware provider settings so image and PDF support can be toggled or routed separately
- better PDF handling through a dedicated document extraction layer instead of relying only on multimodal chat compatibility
- safer debug tooling such as truncated raw model response previews and per-provider diagnostics
- optional selector search or ranking for long project and area lists in Telegram
- shared AI provider extraction primitives that can later be reused by dispatcher and other domain plugins

## Open Questions

- should OCR live inside a shared AI layer or as a separate document extraction capability
- should the AI provider be plugin-local first or immediately shared system-wide
- how much model reasoning metadata should be retained for debugging
- whether project and area hints should be allowed in the first AI version or postponed
- how to surface low-confidence category guesses without cluttering Telegram UX
