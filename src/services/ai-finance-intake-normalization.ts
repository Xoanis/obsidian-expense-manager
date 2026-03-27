import type { ExpenseManagerSettings } from '../settings';
import type { TransactionType } from '../types';
import type {
	AiFinanceExtractionResult,
	FinanceExtractionIssue,
	FinanceIntakeRoute,
	FinanceProposalSource,
} from 'obsidian-para-suite-contracts/finance-intake';
import type { FinanceIntakeIntent } from './finance-intake-types';

interface NormalizeAiFinanceExtractionContext {
	intent: FinanceIntakeIntent;
	route: FinanceIntakeRoute;
	source: FinanceProposalSource;
	descriptionSourceText: string;
}

export function normalizeAiFinanceExtractionResult(
	settings: ExpenseManagerSettings,
	payload: Record<string, unknown>,
	context: NormalizeAiFinanceExtractionContext,
): AiFinanceExtractionResult {
	const rawStatus = payload.status;
	const status = rawStatus === 'success' || rawStatus === 'ambiguous' || rawStatus === 'non_finance' || rawStatus === 'failed'
		? rawStatus
		: 'failed';
	const transactionPayload = asRecord(payload.transaction);
	const transaction = transactionPayload
		? {
			type: asTransactionType(transactionPayload.type, context.intent) ?? undefined,
			amount: asNumber(transactionPayload.amount) ?? undefined,
			currency: asString(transactionPayload.currency) || settings.defaultCurrency,
			dateTime: asString(transactionPayload.dateTime) || undefined,
			description: resolveDescription(
				context.descriptionSourceText,
				asString(transactionPayload.description),
			),
			category: asString(transactionPayload.category) || undefined,
			project: normalizeOptionalWikiLink(asString(transactionPayload.project)),
			area: normalizeOptionalWikiLink(asString(transactionPayload.area)),
			source: context.source,
			artifact: undefined,
		}
		: {
			currency: settings.defaultCurrency,
			source: context.source,
		};
	const fieldConfidences = normalizeFieldConfidences(payload.fieldConfidences);
	const issues = normalizeIssues(payload.issues);
	const overallConfidence = asNumber(payload.overallConfidence) ?? undefined;

	return {
		status,
		providerKind: 'ai',
		route: context.route,
		transaction,
		overallConfidence,
		fieldConfidences,
		issues,
		modelId: settings.aiFinanceModel,
	};
}

function normalizeFieldConfidences(value: unknown): AiFinanceExtractionResult['fieldConfidences'] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => asRecord(item))
		.filter((item): item is Record<string, unknown> => Boolean(item))
		.map((item) => ({
			field: asFieldName(item.field),
			confidence: clampConfidence(asNumber(item.confidence) ?? 0),
		}))
		.filter((item): item is { field: NonNullable<typeof item.field>; confidence: number } => Boolean(item.field));
}

function normalizeIssues(value: unknown): FinanceExtractionIssue[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => asRecord(item))
		.filter((item): item is Record<string, unknown> => Boolean(item))
		.map((item) => ({
			code: asIssueCode(item.code),
			severity: asSeverity(item.severity),
			message: asString(item.message) || 'Unknown AI extraction issue.',
			field: asFieldName(item.field) ?? undefined,
		}));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim()
		? value.trim()
		: null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim()) {
		const normalized = Number(value.replace(',', '.'));
		return Number.isFinite(normalized) ? normalized : null;
	}
	return null;
}

function resolveDescription(
	sourceText: string,
	extractedDescription: string | null,
): string | undefined {
	if (typeof extractedDescription === 'string' && extractedDescription.trim()) {
		return extractedDescription.trim();
	}

	const normalizedSource = sourceText.trim();
	return normalizedSource || undefined;
}

function asTransactionType(
	value: unknown,
	intent: FinanceIntakeIntent,
): TransactionType | null {
	if (intent === 'expense' || intent === 'income') {
		return intent;
	}
	return value === 'income' ? 'income' : value === 'expense' ? 'expense' : null;
}

function asFieldName(value: unknown): AiFinanceExtractionResult['fieldConfidences'][number]['field'] | null {
	return value === 'type'
		|| value === 'amount'
		|| value === 'currency'
		|| value === 'dateTime'
		|| value === 'description'
		|| value === 'category'
		|| value === 'project'
		|| value === 'area'
		? value
		: null;
}

function asIssueCode(value: unknown): FinanceExtractionIssue['code'] {
	return value === 'missing-required-field'
		|| value === 'ambiguous-amount'
		|| value === 'ambiguous-date'
		|| value === 'ambiguous-direction'
		|| value === 'low-confidence-category'
		|| value === 'low-confidence-project'
		|| value === 'low-confidence-area'
		|| value === 'document-extraction-failed'
		|| value === 'non-finance-input'
		|| value === 'provider-error'
		? value
		: 'provider-error';
}

function asSeverity(value: unknown): FinanceExtractionIssue['severity'] {
	return value === 'info' || value === 'warning' || value === 'error'
		? value
		: 'warning';
}

function clampConfidence(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizeOptionalWikiLink(value: string | null): string | undefined {
	if (!value) {
		return undefined;
	}

	if (/^\[\[.*\]\]$/.test(value)) {
		return value;
	}

	return `[[${value}]]`;
}
