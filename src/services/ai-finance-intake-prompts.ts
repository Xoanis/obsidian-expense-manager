import type { ExpenseManagerSettings } from '../settings';
import type { DocumentExtractionResult } from './document-extraction-service';
import type {
	FinanceIntakeIntent,
	FinanceReceiptProposalRequest,
	FinanceTextProposalRequest,
} from './finance-intake-types';

export function buildAiFinanceSystemPrompt(): string {
	return [
		'You extract personal finance transactions from user inputs.',
		'Return only valid JSON.',
		'Decide whether the input is finance-related.',
		'Keep description in the same language as the user input whenever possible.',
		'Do not translate the description unless the user input itself is translated.',
		'If the input is in Russian, keep the description in Russian.',
		'Do not guess project or area unless the text clearly contains them.',
		'If uncertain, prefer ambiguous or missing fields over fabricated certainty.',
		'Use this schema:',
		'{',
		'  "status": "success" | "ambiguous" | "non_finance" | "failed",',
		'  "overallConfidence": number,',
		'  "transaction": {',
		'    "type": "expense" | "income" | null,',
		'    "amount": number | null,',
		'    "currency": string,',
		'    "dateTime": string | null,',
		'    "description": string | null,',
		'    "category": string | null,',
		'    "project": string | null,',
		'    "area": string | null',
		'  },',
		'  "fieldConfidences": [',
		'    { "field": "type" | "amount" | "currency" | "dateTime" | "description" | "category" | "project" | "area", "confidence": number }',
		'  ],',
		'  "issues": [',
		'    { "code": string, "severity": "info" | "warning" | "error", "message": string, "field": string | null }',
		'  ]',
		'}',
	].join('\n');
}

export function buildAiFinanceReceiptSystemPrompt(): string {
	return [
		buildAiFinanceSystemPrompt(),
		'You may receive a receipt image or a banking operation screenshot.',
		'Use the visual or document evidence as the primary source.',
		'If a caption is present, use it as a hint but do not let it override clearly visible document data.',
		'For receipt or document inputs, prefer concise factual descriptions over generic phrases.',
	].join('\n');
}

export function buildAiFinancePdfSystemPrompt(): string {
	return [
		buildAiFinanceSystemPrompt(),
		'You receive text already extracted from a finance-related PDF document.',
		'Rely on the extracted document text as the primary evidence.',
		'If extraction warnings are present, be conservative and prefer ambiguous fields over fabricated certainty.',
		'Do not assume the document is finance-related just because it came through a finance command.',
	].join('\n');
}

export function buildAiFinanceTextUserPayload(
	settings: ExpenseManagerSettings,
	request: FinanceTextProposalRequest,
): Record<string, unknown> {
	return {
		intent: request.intent,
		text: request.text,
		defaultCurrency: settings.defaultCurrency,
		defaultProject: request.project ?? null,
		defaultArea: request.area ?? null,
		knownCategories: request.knownCategories ?? getKnownCategoriesForIntent(settings, request.intent),
		knownProjects: request.knownProjects ?? [],
		knownAreas: request.knownAreas ?? [],
		now: new Date().toISOString(),
	};
}

export function buildAiFinanceReceiptUserPayload(
	settings: ExpenseManagerSettings,
	request: FinanceReceiptProposalRequest,
): Record<string, unknown> {
	return {
		intent: request.intent,
		caption: request.caption ?? '',
		fileName: request.fileName,
		mimeType: request.mimeType ?? null,
		defaultCurrency: settings.defaultCurrency,
		defaultProject: request.project ?? null,
		defaultArea: request.area ?? null,
		knownCategories: request.knownCategories ?? getKnownCategoriesForIntent(settings, request.intent),
		knownProjects: request.knownProjects ?? [],
		knownAreas: request.knownAreas ?? [],
		now: new Date().toISOString(),
	};
}

export function buildAiFinancePdfUserPayload(
	settings: ExpenseManagerSettings,
	request: FinanceReceiptProposalRequest,
	extraction: DocumentExtractionResult,
): Record<string, unknown> {
	return {
		intent: request.intent,
		caption: request.caption ?? '',
		fileName: request.fileName,
		mimeType: request.mimeType ?? null,
		defaultCurrency: settings.defaultCurrency,
		defaultProject: request.project ?? null,
		defaultArea: request.area ?? null,
		knownCategories: request.knownCategories ?? getKnownCategoriesForIntent(settings, request.intent),
		knownProjects: request.knownProjects ?? [],
		knownAreas: request.knownAreas ?? [],
		documentProvider: extraction.provider,
		documentWarnings: extraction.warnings,
		documentText: extraction.text,
		pages: extraction.pages,
		now: new Date().toISOString(),
	};
}

export function buildAiFinanceReceiptUserContent(
	settings: ExpenseManagerSettings,
	request: FinanceReceiptProposalRequest,
	artifactDataUrl: string,
): Array<Record<string, unknown>> {
	return [
		{
			type: 'text',
			text: JSON.stringify(buildAiFinanceReceiptUserPayload(settings, request)),
		},
		{
			type: 'image_url',
			image_url: {
				url: artifactDataUrl,
			},
		},
	];
}

export function parseAiFinanceJsonObject(content: string): Record<string, unknown> {
	const trimmed = content.trim();
	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const jsonText = fencedMatch ? fencedMatch[1].trim() : trimmed;
	return JSON.parse(jsonText) as Record<string, unknown>;
}

function getKnownCategoriesForIntent(
	settings: ExpenseManagerSettings,
	intent: FinanceIntakeIntent,
): string[] {
	if (intent === 'income') {
		return settings.incomeCategories;
	}
	if (intent === 'expense') {
		return settings.expenseCategories;
	}
	return Array.from(new Set([
		...settings.expenseCategories,
		...settings.incomeCategories,
	]));
}
