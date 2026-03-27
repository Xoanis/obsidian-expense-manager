import { requestUrl } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import { TransactionData, TransactionType } from '../types';
import { ProverkaChekaClient } from '../utils/api-client';
import { ConsolePluginLogger, PluginLogger } from '../utils/plugin-debug-log';
import {
	createDefaultDocumentExtractionService,
	DocumentExtractionRequest,
	DocumentExtractionResult,
	DocumentExtractionService,
	isUsableDocumentExtractionResult,
} from './document-extraction-service';
import type {
	AiFinanceExtractionResult,
	FinanceExtractionIssue,
	FinanceIntakeRoute,
	FinanceProposalSource,
} from 'obsidian-para-suite-contracts/finance-intake';

export type FinanceIntakeIntent = TransactionType | 'neutral';

export interface FinanceMetadataHints {
	area?: string;
	project?: string;
}

export interface FinanceCaptionMetadata extends FinanceMetadataHints {
	comment: string;
}

export interface FinanceTextProposalRequest extends FinanceMetadataHints {
	text: string;
	intent: FinanceIntakeIntent;
	source?: TransactionData['source'];
	knownCategories?: string[];
	knownProjects?: string[];
	knownAreas?: string[];
}

export interface FinanceReceiptProposalRequest extends FinanceMetadataHints {
	bytes: ArrayBuffer;
	fileName: string;
	mimeType?: string;
	caption?: string;
	intent: FinanceIntakeIntent;
	source?: TransactionData['source'];
	knownCategories?: string[];
	knownProjects?: string[];
	knownAreas?: string[];
}

export interface FinanceReceiptProposalResult {
	data: TransactionData;
	source: 'api' | 'local';
}

export interface FinanceIntakeRoutingDecision {
	providerKind: 'rule-based' | 'ai';
	route: FinanceIntakeRoute;
	reason: string;
}

export interface FinanceIntakeProvider {
	createTextTransaction(request: FinanceTextProposalRequest): Promise<TransactionData | null>;
	createReceiptTransaction(request: FinanceReceiptProposalRequest): Promise<FinanceReceiptProposalResult>;
}

interface ParsedTelegramTransactionInput extends FinanceMetadataHints {
	amount: number;
	comment: string;
}

interface ParsedFlexibleTelegramTransactionInput extends ParsedTelegramTransactionInput {
	transactionType: TransactionType;
}

interface FinanceIntakeServiceOptions {
	ruleProvider?: FinanceIntakeProvider;
	aiProvider?: FinanceIntakeProvider;
	documentExtractionService?: DocumentExtractionService;
	logger?: PluginLogger;
}

interface OpenAiCompatibleChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}

export class RuleBasedFinanceIntakeProvider implements FinanceIntakeProvider {
	constructor(private readonly settings: ExpenseManagerSettings) {}

	async createTextTransaction(
		request: FinanceTextProposalRequest,
	): Promise<TransactionData | null> {
		const parsed = this.parseArgsForIntent(request.text, request.intent);
		if (!parsed || parsed.amount <= 0) {
			return null;
		}

		return this.makeTransactionData(parsed.transactionType, parsed.amount, parsed.comment, {
			area: request.area ?? parsed.area,
			project: request.project ?? parsed.project,
		}, request.source ?? 'telegram');
	}

	async createReceiptTransaction(
		request: FinanceReceiptProposalRequest,
	): Promise<FinanceReceiptProposalResult> {
		const blob = new Blob([request.bytes], {
			type: request.mimeType || 'image/jpeg',
		});
		const client = new ProverkaChekaClient(
			this.settings.proverkaChekaApiKey,
			this.settings.localQrOnly,
		);
		const result = await client.processReceiptHybrid(blob);
		if (result.hasError) {
			throw new Error(result.error || 'Unknown receipt processing error');
		}

		const captionMetadata = this.parseCaption(request.caption || '');
		const data: TransactionData = {
			...result.data,
			type: request.intent === 'neutral' ? result.data.type : request.intent,
			source: request.source ?? 'telegram',
			area: captionMetadata.area ?? request.area ?? undefined,
			project: captionMetadata.project ?? request.project ?? undefined,
			description: captionMetadata.comment || result.data.description,
			artifactBytes: request.bytes,
			artifactFileName: request.fileName,
			artifactMimeType: request.mimeType,
		};

		return {
			data,
			source: result.source,
		};
	}

	private parseArgsForIntent(
		args: string,
		intent: FinanceIntakeIntent,
	): ParsedFlexibleTelegramTransactionInput | null {
		if (intent === 'neutral') {
			return this.parseNeutralArgs(args);
		}

		const parsed = this.parseArgs(args);
		if (!parsed) {
			return null;
		}

		return {
			...parsed,
			transactionType: intent,
		};
	}

	private parseNeutralArgs(args: string): ParsedFlexibleTelegramTransactionInput | null {
		const commandMatch = args.match(/^\/?(expense|income)\s+(.+)$/i);
		if (commandMatch) {
			const [, rawType, payload] = commandMatch;
			const parsed = this.parseArgs(payload);
			if (!parsed) {
				return null;
			}

			return {
				...parsed,
				transactionType: rawType.toLowerCase() === 'income' ? 'income' : 'expense',
			};
		}

		const parsed = this.parseArgs(args);
		if (!parsed) {
			return null;
		}

		const trimmed = args.trim();
		const firstPart = trimmed.split('|')[0]?.trim() ?? '';
		const amountToken = firstPart.split(/\s+/)[0] ?? '';
		if (amountToken.startsWith('+')) {
			return {
				...parsed,
				transactionType: 'income',
				amount: Math.abs(parsed.amount),
			};
		}
		if (amountToken.startsWith('-')) {
			return {
				...parsed,
				transactionType: 'expense',
				amount: Math.abs(parsed.amount),
			};
		}

		return null;
	}

	private parseArgs(args: string): ParsedTelegramTransactionInput | null {
		const trimmed = args.trim();
		if (!trimmed) {
			return null;
		}

		const [head, ...metadataParts] = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
		if (!head) {
			return null;
		}

		const [amountStr, ...commentParts] = head.split(/\s+/);
		const amount = parseFloat(amountStr);
		const comment = commentParts.join(' ').trim();
		if (Number.isNaN(amount) || !comment) {
			return null;
		}

		const metadata = this.parseMetadataParts(metadataParts);
		return {
			amount,
			comment,
			area: metadata.area,
			project: metadata.project,
		};
	}

	private makeTransactionData(
		type: TransactionType,
		amount: number,
		comment: string,
		metadata?: FinanceMetadataHints,
		source: TransactionData['source'] = 'telegram',
	): TransactionData {
		return {
			type,
			amount,
			currency: this.settings.defaultCurrency,
			dateTime: new Date().toISOString(),
			description: comment,
			area: metadata?.area,
			project: metadata?.project,
			tags: ['telegram'],
			category: 'Other',
			source,
		};
	}

	parseCaption(caption: string): FinanceCaptionMetadata {
		const parts = caption
			.split('|')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return { comment: '' };
		}

		const [comment, ...metadataParts] = parts;
		const metadata = this.parseMetadataParts(metadataParts);
		return {
			comment,
			area: metadata.area,
			project: metadata.project,
		};
	}

	extractMetadataHints(value: string): FinanceMetadataHints {
		const parts = value
			.split('|')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return {};
		}

		const metadataParts = parts.length > 1 ? parts.slice(1) : parts;
		return this.parseMetadataParts(metadataParts);
	}

	private parseMetadataParts(parts: string[]): FinanceMetadataHints {
		const result: FinanceMetadataHints = {};
		for (const part of parts) {
			const [rawKey, ...rawValueParts] = part.split('=');
			if (!rawKey || rawValueParts.length === 0) {
				continue;
			}

			const key = rawKey.trim().toLowerCase();
			const rawValue = rawValueParts.join('=').trim();
			if (!rawValue) {
				continue;
			}

			if (key === 'area') {
				result.area = this.normalizeWikiLink(rawValue);
			}
			if (key === 'project') {
				result.project = this.normalizeWikiLink(rawValue);
			}
		}
		return result;
	}

	private normalizeWikiLink(value: string): string {
		const trimmed = value.trim();
		if (/^\[\[.*\]\]$/.test(trimmed)) {
			return trimmed;
		}
		return `[[${trimmed}]]`;
	}
}

export class AiFinanceIntakeProvider implements FinanceIntakeProvider {
	constructor(
		private readonly settings: ExpenseManagerSettings,
		private readonly documentExtractionService: DocumentExtractionService = createDefaultDocumentExtractionService(),
		private readonly logger: PluginLogger = new ConsolePluginLogger(),
	) {}

	async createTextTransaction(
		request: FinanceTextProposalRequest,
	): Promise<TransactionData | null> {
		const result = await this.extractText(request);
		return this.toTransactionData(result, request.source ?? 'telegram');
	}

	async createReceiptTransaction(
		request: FinanceReceiptProposalRequest,
	): Promise<FinanceReceiptProposalResult> {
		const stableRequest = this.cloneReceiptRequest(request);
		const result = await this.extractReceipt(stableRequest);
		const data = this.toTransactionData(result, stableRequest.source ?? 'telegram');
		if (!data) {
			throw new Error(this.toFailureMessage(result.issues));
		}

		data.artifactBytes = this.cloneArrayBuffer(stableRequest.bytes);
		data.artifactFileName = stableRequest.fileName;
		data.artifactMimeType = stableRequest.mimeType;

		return {
			data,
			source: 'api',
		};
	}

	async extractText(
		request: FinanceTextProposalRequest,
	): Promise<AiFinanceExtractionResult> {
		if (!this.isConfigured()) {
			this.logger.warn('AiFinanceIntakeProvider.extractText: AI text extraction is not configured.');
			return this.createNotImplementedResult('ai-text', this.getTextSource(request), [
				'AI finance text extraction is not configured.',
			]);
		}

		try {
			const parsed = await this.requestJsonChatCompletion([
				{
					role: 'system',
					content: this.buildSystemPrompt(),
				},
				{
					role: 'user',
					content: JSON.stringify(this.buildTextUserPayload(request)),
				},
			], 'AiFinanceIntakeProvider.extractText', {
				intent: request.intent,
				textLength: request.text.length,
			});
			const result = this.normalizeAiExtractionResult(parsed, {
				intent: request.intent,
				route: 'ai-text',
				source: this.getTextSource(request),
				descriptionSourceText: request.text,
			});
			this.logger.info('AiFinanceIntakeProvider.extractText: normalized result', {
				status: result.status,
				overallConfidence: result.overallConfidence,
				type: result.transaction?.type,
				amount: result.transaction?.amount,
				category: result.transaction?.category,
				issueCount: result.issues.length,
			});
			return result;
		} catch (error) {
			this.logger.error('AiFinanceIntakeProvider.extractText: request failed', error);
			return this.createNotImplementedResult('ai-text', this.getTextSource(request), [
				`AI finance extraction request failed: ${(error as Error).message}`,
			]);
		}
	}

	async extractReceipt(
		request: FinanceReceiptProposalRequest,
	): Promise<AiFinanceExtractionResult> {
		if (this.isPdfRequest(request)) {
			return this.extractPdfReceipt(request);
		}

		return this.extractImageReceipt(request);
	}

	private async extractImageReceipt(
		request: FinanceReceiptProposalRequest,
	): Promise<AiFinanceExtractionResult> {
		const route: FinanceIntakeRoute = this.isPdfRequest(request) ? 'ai-pdf' : 'ai-image';
		const source: FinanceProposalSource = this.isPdfRequest(request) ? 'telegram-pdf' : 'telegram-image';
		if (!this.isConfigured()) {
			this.logger.warn('AiFinanceIntakeProvider.extractReceipt: AI receipt extraction is not configured.');
			return this.createNotImplementedResult(route, source, [
				'AI finance receipt extraction is not configured.',
			]);
		}

		const artifactDataUrl = this.toDataUrl(request.bytes, request.mimeType || (this.isPdfRequest(request) ? 'application/pdf' : 'image/jpeg'));
		if (!artifactDataUrl) {
			return this.createNotImplementedResult(route, source, [
				'Receipt artifact is too large for inline AI processing. Try a smaller image.',
			]);
		}

		try {
			const parsed = await this.requestJsonChatCompletion([
				{
					role: 'system',
					content: this.buildReceiptSystemPrompt(),
				},
				{
					role: 'user',
					content: this.buildReceiptUserContent(request, artifactDataUrl),
				},
			], 'AiFinanceIntakeProvider.extractReceipt', {
				intent: request.intent,
				fileName: request.fileName,
				mimeType: request.mimeType,
				byteLength: request.bytes.byteLength,
				route,
			});
			const result = this.normalizeAiExtractionResult(parsed, {
				intent: request.intent,
				route,
				source,
				descriptionSourceText: request.caption || request.fileName,
			});
			this.logger.info('AiFinanceIntakeProvider.extractReceipt: normalized result', {
				status: result.status,
				overallConfidence: result.overallConfidence,
				type: result.transaction?.type,
				amount: result.transaction?.amount,
				category: result.transaction?.category,
				issueCount: result.issues.length,
			});
			return result;
		} catch (error) {
			this.logger.error('AiFinanceIntakeProvider.extractReceipt: request failed', error);
			return this.createReceiptFailureResult(route, source, error as Error);
		}
	}

	private async extractPdfReceipt(
		request: FinanceReceiptProposalRequest,
	): Promise<AiFinanceExtractionResult> {
		const route: FinanceIntakeRoute = 'ai-pdf';
		const source: FinanceProposalSource = 'telegram-pdf';
		if (!this.isConfigured()) {
			this.logger.warn('AiFinanceIntakeProvider.extractPdfReceipt: AI receipt extraction is not configured.');
			return this.createNotImplementedResult(route, source, [
				'AI finance receipt extraction is not configured.',
			]);
		}

		try {
			const extraction = await this.documentExtractionService.extractPdf(this.toDocumentExtractionRequest(request));
			this.logger.info('AiFinanceIntakeProvider.extractPdfReceipt: document extraction result', {
				status: extraction.status,
				textLength: extraction.text.length,
				pageCount: extraction.pages.length,
				warnings: extraction.warnings,
				provider: extraction.provider,
				textPreview: extraction.text.slice(0, 800),
			});
			if (!isUsableDocumentExtractionResult(extraction)) {
				this.logger.info('AiFinanceIntakeProvider.extractPdfReceipt: text extraction unusable, returning unsupported result', {
					status: extraction.status,
					warnings: extraction.warnings,
					textLength: extraction.text.length,
				});
				return this.createNotImplementedResult(route, source, this.uniqueMessages([
					...extraction.warnings,
					'Only text-based PDFs are supported in the current iteration.',
					'This PDF appears image-based, scanned, encrypted, or otherwise missing a usable text layer.',
				]));
			}

			const parsed = await this.requestJsonChatCompletion([
				{
					role: 'system',
					content: this.buildPdfSystemPrompt(),
				},
				{
					role: 'user',
					content: JSON.stringify(this.buildPdfUserPayload(request, extraction)),
				},
			], 'AiFinanceIntakeProvider.extractPdfReceipt', {
				intent: request.intent,
				fileName: request.fileName,
				mimeType: request.mimeType,
				textLength: extraction.text.length,
				pageCount: extraction.pages.length,
				warnings: extraction.warnings,
			});
			const result = this.normalizeAiExtractionResult(parsed, {
				intent: request.intent,
				route,
				source,
				descriptionSourceText: request.caption || extraction.text,
			});
			this.logger.info('AiFinanceIntakeProvider.extractPdfReceipt: normalized result', {
				status: result.status,
				overallConfidence: result.overallConfidence,
				type: result.transaction?.type,
				amount: result.transaction?.amount,
				category: result.transaction?.category,
				issueCount: result.issues.length,
			});
			if (extraction.warnings.length > 0) {
				result.issues = [
					...result.issues,
					...extraction.warnings.map((message) => ({
						code: 'document-extraction-failed' as const,
						severity: 'warning' as const,
						message,
					})),
				];
			}
			return result;
		} catch (error) {
			this.logger.error('AiFinanceIntakeProvider.extractPdfReceipt: request failed', error);
			return this.createReceiptFailureResult(route, source, error as Error);
		}
	}

	private createNotImplementedResult(
		route: FinanceIntakeRoute,
		source: FinanceProposalSource,
		messages: string[],
	): AiFinanceExtractionResult {
		return {
			status: 'failed',
			providerKind: 'ai',
			route,
			transaction: {
				currency: this.settings.defaultCurrency,
				source,
			},
			fieldConfidences: [],
			issues: messages.map((message) => ({
				code: 'provider-error',
				severity: 'warning',
				message,
			})),
		};
	}

	private createReceiptFailureResult(
		route: FinanceIntakeRoute,
		source: FinanceProposalSource,
		error: Error,
	): AiFinanceExtractionResult {
		const lowerMessage = error.message.toLowerCase();
		if (route === 'ai-pdf' && /status 5\d\d/.test(lowerMessage)) {
			return this.createNotImplementedResult(route, source, [
				'The configured AI endpoint returned a server error while normalizing extracted PDF text.',
				'The PDF text layer was extracted locally, but the AI endpoint could not finish the structured normalization step.',
			]);
		}

		if (route === 'ai-image' && /image_unreadable|unable to process the provided image/i.test(lowerMessage)) {
			return this.createNotImplementedResult(route, source, [
				'The AI model reported that it could not read the image.',
				'For QR receipts we now prefer deterministic QR extraction before AI fallback, because many text-only or partially multimodal endpoints are unreliable on even clear QR images.',
			]);
		}

		return this.createNotImplementedResult(route, source, [
			`AI finance receipt extraction request failed: ${error.message}`,
		]);
	}

	private toTransactionData(
		result: AiFinanceExtractionResult,
		source: TransactionData['source'],
	): TransactionData | null {
		if (result.status !== 'success' && result.status !== 'ambiguous') {
			return null;
		}

		const transaction = result.transaction;
		if (!transaction?.type || typeof transaction.amount !== 'number' || !transaction.description) {
			return null;
		}

		return {
			type: transaction.type,
			amount: transaction.amount,
			currency: transaction.currency || this.settings.defaultCurrency,
			dateTime: transaction.dateTime || new Date().toISOString(),
			description: transaction.description,
			category: transaction.category || 'Other',
			project: transaction.project,
			area: transaction.area,
			artifact: transaction.artifact,
			source,
			tags: ['telegram'],
		};
	}

	private toFailureMessage(issues: FinanceExtractionIssue[]): string {
		return issues[0]?.message || 'AI finance extraction failed.';
	}

	private isConfigured(): boolean {
		return Boolean(
			this.settings.enableAiFinanceTextIntake
			&& this.settings.aiFinanceApiBaseUrl.trim()
			&& this.settings.aiFinanceApiKey.trim()
			&& this.settings.aiFinanceModel.trim(),
		);
	}

	private getChatCompletionsUrl(): string {
		return `${this.settings.aiFinanceApiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
	}

	private async requestJsonChatCompletion(
		messages: Array<Record<string, unknown>>,
		logLabel: string,
		logContext: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		this.logger.info(`${logLabel}: sending request`, {
			model: this.settings.aiFinanceModel,
			baseUrl: this.settings.aiFinanceApiBaseUrl,
			...logContext,
		});

		const response = await requestUrl({
			url: this.getChatCompletionsUrl(),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.settings.aiFinanceApiKey}`,
			},
			body: JSON.stringify({
				model: this.settings.aiFinanceModel,
				temperature: 0.1,
				response_format: {
					type: 'json_object',
				},
				messages,
			}),
		});

		this.logger.info(`${logLabel}: received response`, {
			status: response.status,
			textLength: response.text.length,
			responsePreview: response.text.slice(0, 400),
		});
		const payload = JSON.parse(response.text) as OpenAiCompatibleChatCompletionResponse;
		const content = payload.choices?.[0]?.message?.content;
		if (!content) {
			throw new Error('AI finance endpoint returned an empty response.');
		}

		this.logger.info(`${logLabel}: content preview`, {
			contentPreview: content.slice(0, 400),
		});
		return this.parseJsonObject(content);
	}

	private buildSystemPrompt(): string {
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

	private buildReceiptSystemPrompt(): string {
		return [
			this.buildSystemPrompt(),
			'You may receive a receipt image or a banking operation screenshot.',
			'Use the visual or document evidence as the primary source.',
			'If a caption is present, use it as a hint but do not let it override clearly visible document data.',
			'For receipt or document inputs, prefer concise factual descriptions over generic phrases.',
		].join('\n');
	}

	private buildPdfSystemPrompt(): string {
		return [
			this.buildSystemPrompt(),
			'You receive text already extracted from a finance-related PDF document.',
			'Rely on the extracted document text as the primary evidence.',
			'If extraction warnings are present, be conservative and prefer ambiguous fields over fabricated certainty.',
			'Do not assume the document is finance-related just because it came through a finance command.',
		].join('\n');
	}

	private buildTextUserPayload(request: FinanceTextProposalRequest): Record<string, unknown> {
		return {
			intent: request.intent,
			text: request.text,
			defaultCurrency: this.settings.defaultCurrency,
			defaultProject: request.project ?? null,
			defaultArea: request.area ?? null,
			knownCategories: request.knownCategories ?? this.getKnownCategoriesForIntent(request.intent),
			knownProjects: request.knownProjects ?? [],
			knownAreas: request.knownAreas ?? [],
			now: new Date().toISOString(),
		};
	}

	private buildReceiptUserPayload(request: FinanceReceiptProposalRequest): Record<string, unknown> {
		return {
			intent: request.intent,
			caption: request.caption ?? '',
			fileName: request.fileName,
			mimeType: request.mimeType ?? null,
			defaultCurrency: this.settings.defaultCurrency,
			defaultProject: request.project ?? null,
			defaultArea: request.area ?? null,
			knownCategories: request.knownCategories ?? this.getKnownCategoriesForIntent(request.intent),
			knownProjects: request.knownProjects ?? [],
			knownAreas: request.knownAreas ?? [],
			now: new Date().toISOString(),
		};
	}

	private buildPdfUserPayload(
		request: FinanceReceiptProposalRequest,
		extraction: DocumentExtractionResult,
	): Record<string, unknown> {
		return {
			intent: request.intent,
			caption: request.caption ?? '',
			fileName: request.fileName,
			mimeType: request.mimeType ?? null,
			defaultCurrency: this.settings.defaultCurrency,
			defaultProject: request.project ?? null,
			defaultArea: request.area ?? null,
			knownCategories: request.knownCategories ?? this.getKnownCategoriesForIntent(request.intent),
			knownProjects: request.knownProjects ?? [],
			knownAreas: request.knownAreas ?? [],
			documentProvider: extraction.provider,
			documentWarnings: extraction.warnings,
			documentText: extraction.text,
			pages: extraction.pages,
			now: new Date().toISOString(),
		};
	}

	private buildReceiptUserContent(
		request: FinanceReceiptProposalRequest,
		artifactDataUrl: string,
	): Array<Record<string, unknown>> {
		const content: Array<Record<string, unknown>> = [{
			type: 'text',
			text: JSON.stringify(this.buildReceiptUserPayload(request)),
		}];

		content.push({
			type: 'image_url',
			image_url: {
				url: artifactDataUrl,
			},
		});
		return content;
	}

	private toDocumentExtractionRequest(request: FinanceReceiptProposalRequest): DocumentExtractionRequest {
		return {
			bytes: this.cloneArrayBuffer(request.bytes),
			fileName: request.fileName,
			mimeType: request.mimeType,
		};
	}

	private cloneReceiptRequest(request: FinanceReceiptProposalRequest): FinanceReceiptProposalRequest {
		return {
			...request,
			bytes: this.cloneArrayBuffer(request.bytes),
		};
	}

	private cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
		return Uint8Array.from(new Uint8Array(buffer)).buffer;
	}

	private uniqueMessages(messages: string[]): string[] {
		return Array.from(new Set(messages.filter(Boolean)));
	}

	private getKnownCategoriesForIntent(intent: FinanceIntakeIntent): string[] {
		if (intent === 'income') {
			return this.settings.incomeCategories;
		}
		if (intent === 'expense') {
			return this.settings.expenseCategories;
		}
		return Array.from(new Set([
			...this.settings.expenseCategories,
			...this.settings.incomeCategories,
		]));
	}

	private parseJsonObject(content: string): Record<string, unknown> {
		const trimmed = content.trim();
		const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const jsonText = fencedMatch ? fencedMatch[1].trim() : trimmed;
		return JSON.parse(jsonText) as Record<string, unknown>;
	}

	private normalizeAiExtractionResult(
		payload: Record<string, unknown>,
		context: {
			intent: FinanceIntakeIntent;
			route: FinanceIntakeRoute;
			source: FinanceProposalSource;
			descriptionSourceText: string;
		},
	): AiFinanceExtractionResult {
		const rawStatus = payload.status;
		const status = rawStatus === 'success' || rawStatus === 'ambiguous' || rawStatus === 'non_finance' || rawStatus === 'failed'
			? rawStatus
			: 'failed';
		const transactionPayload = this.asRecord(payload.transaction);
		const transaction = transactionPayload
			? {
				type: this.asTransactionType(transactionPayload.type, context.intent) ?? undefined,
				amount: this.asNumber(transactionPayload.amount) ?? undefined,
				currency: this.asString(transactionPayload.currency) || this.settings.defaultCurrency,
				dateTime: this.asString(transactionPayload.dateTime) || undefined,
				description: this.resolveDescription(
					context.descriptionSourceText,
					this.asString(transactionPayload.description),
				),
				category: this.asString(transactionPayload.category) || undefined,
				project: this.normalizeOptionalWikiLink(this.asString(transactionPayload.project)),
				area: this.normalizeOptionalWikiLink(this.asString(transactionPayload.area)),
				source: context.source,
				artifact: undefined,
			}
			: {
				currency: this.settings.defaultCurrency,
				source: context.source,
			};
		const fieldConfidences = this.normalizeFieldConfidences(payload.fieldConfidences);
		const issues = this.normalizeIssues(payload.issues);
		const overallConfidence = this.asNumber(payload.overallConfidence) ?? undefined;

		return {
			status,
			providerKind: 'ai',
			route: context.route,
			transaction,
			overallConfidence,
			fieldConfidences,
			issues,
			modelId: this.settings.aiFinanceModel,
		};
	}

	private normalizeFieldConfidences(value: unknown): AiFinanceExtractionResult['fieldConfidences'] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value
			.map((item) => this.asRecord(item))
			.filter((item): item is Record<string, unknown> => Boolean(item))
			.map((item) => ({
				field: this.asFieldName(item.field),
				confidence: this.clampConfidence(this.asNumber(item.confidence) ?? 0),
			}))
			.filter((item): item is { field: NonNullable<typeof item.field>; confidence: number } => Boolean(item.field));
	}

	private normalizeIssues(value: unknown): FinanceExtractionIssue[] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value
			.map((item) => this.asRecord(item))
			.filter((item): item is Record<string, unknown> => Boolean(item))
			.map((item) => ({
				code: this.asIssueCode(item.code),
				severity: this.asSeverity(item.severity),
				message: this.asString(item.message) || 'Unknown AI extraction issue.',
				field: this.asFieldName(item.field) ?? undefined,
			}));
	}

	private asRecord(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? value as Record<string, unknown>
			: null;
	}

	private asString(value: unknown): string | null {
		return typeof value === 'string' && value.trim()
			? value.trim()
			: null;
	}

	private asNumber(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim()) {
			const normalized = Number(value.replace(',', '.'));
			return Number.isFinite(normalized) ? normalized : null;
		}
		return null;
	}

	private resolveDescription(
		sourceText: string,
		extractedDescription: string | null,
	): string | undefined {
		if (typeof extractedDescription === 'string' && extractedDescription.trim()) {
			return extractedDescription.trim();
		}

		const normalizedSource = sourceText.trim();
		return normalizedSource || undefined;
	}

	private asTransactionType(
		value: unknown,
		intent: FinanceTextProposalRequest['intent'],
	): TransactionType | null {
		if (intent === 'expense' || intent === 'income') {
			return intent;
		}
		return value === 'income' ? 'income' : value === 'expense' ? 'expense' : null;
	}

	private asFieldName(value: unknown): AiFinanceExtractionResult['fieldConfidences'][number]['field'] | null {
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

	private asIssueCode(value: unknown): FinanceExtractionIssue['code'] {
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

	private asSeverity(value: unknown): FinanceExtractionIssue['severity'] {
		return value === 'info' || value === 'warning' || value === 'error'
			? value
			: 'warning';
	}

	private clampConfidence(value: number): number {
		return Math.max(0, Math.min(1, value));
	}

	private normalizeOptionalWikiLink(value: string | null): string | undefined {
		if (!value) {
			return undefined;
		}

		if (/^\[\[.*\]\]$/.test(value)) {
			return value;
		}

		return `[[${value}]]`;
	}

	private toDataUrl(bytes: ArrayBuffer, mimeType: string): string | null {
		const maxInlineBytes = 4 * 1024 * 1024;
		if (bytes.byteLength > maxInlineBytes) {
			this.logger.warn('AiFinanceIntakeProvider.toDataUrl: artifact exceeds inline size limit', {
				byteLength: bytes.byteLength,
				maxInlineBytes,
				mimeType,
			});
			return null;
		}

		const base64 = Buffer.from(new Uint8Array(bytes)).toString('base64');
		return `data:${mimeType};base64,${base64}`;
	}

	private isPdfRequest(request: FinanceReceiptProposalRequest): boolean {
		return Boolean(
			request.mimeType?.toLowerCase() === 'application/pdf'
			|| request.fileName.toLowerCase().endsWith('.pdf'),
		);
	}

	private getTextSource(request: FinanceTextProposalRequest): FinanceProposalSource {
		return 'telegram-text';
	}
}

export class FinanceIntakeService {
	private readonly ruleProvider: FinanceIntakeProvider;
	private readonly aiProvider: FinanceIntakeProvider;
	private readonly logger: PluginLogger;

	constructor(
		private readonly settings: ExpenseManagerSettings,
		options?: FinanceIntakeServiceOptions,
	) {
		this.logger = options?.logger ?? new ConsolePluginLogger();
		this.ruleProvider = options?.ruleProvider ?? new RuleBasedFinanceIntakeProvider(settings);
		this.aiProvider = options?.aiProvider ?? new AiFinanceIntakeProvider(
			settings,
			options?.documentExtractionService ?? createDefaultDocumentExtractionService(),
			this.logger,
		);
	}

	async createTextProposal(
		request: FinanceTextProposalRequest,
	): Promise<TransactionData | null> {
		const decision = this.routeTextRequest(request);
		this.logger.info('FinanceIntakeService.createTextProposal: route selected', decision);
		if (decision.providerKind === 'ai') {
			const aiResult = await this.aiProvider.createTextTransaction(request);
			if (aiResult) {
				this.logger.info('FinanceIntakeService.createTextProposal: AI provider produced a transaction.');
				return aiResult;
			}
			this.logger.warn('FinanceIntakeService.createTextProposal: AI provider returned no transaction, falling back to rule-based provider.');
			return this.ruleProvider.createTextTransaction(request);
		}

		return this.ruleProvider.createTextTransaction(request);
	}

	async createReceiptProposal(
		request: FinanceReceiptProposalRequest,
	): Promise<FinanceReceiptProposalResult> {
		const decision = this.routeReceiptRequest(request);
		this.logger.info('FinanceIntakeService.createReceiptProposal: route selected', decision);
		if (!this.isPdfRequest(request) && this.isAiTextEnabled()) {
			try {
				const ruleResult = await this.ruleProvider.createReceiptTransaction(request);
				this.logger.info('FinanceIntakeService.createReceiptProposal: rule-based receipt extraction succeeded before AI fallback was needed.');
				return ruleResult;
			} catch (error) {
				this.logger.warn('FinanceIntakeService.createReceiptProposal: rule-based receipt extraction failed, trying AI fallback.', error);
			}
		}

		if (decision.providerKind === 'ai') {
			try {
				return await this.aiProvider.createReceiptTransaction(request);
			} catch (error) {
				if (!this.isPdfRequest(request)) {
					return this.ruleProvider.createReceiptTransaction(request);
				}
				throw error;
			}
		}

		return this.ruleProvider.createReceiptTransaction(request);
	}

	parseCaption(caption: string): FinanceCaptionMetadata {
		if (this.ruleProvider instanceof RuleBasedFinanceIntakeProvider) {
			return this.ruleProvider.parseCaption(caption);
		}
		return { comment: '' };
	}

	extractMetadataHints(value: string): FinanceMetadataHints {
		if (this.ruleProvider instanceof RuleBasedFinanceIntakeProvider) {
			return this.ruleProvider.extractMetadataHints(value);
		}
		return {};
	}

	getSettings(): ExpenseManagerSettings {
		return this.settings;
	}

	routeTextRequest(request: FinanceTextProposalRequest): FinanceIntakeRoutingDecision {
		if (this.isAiTextEnabled() && request.intent === 'neutral' && !this.looksSimpleStructuredText(request.text)) {
			return {
				providerKind: 'ai',
				route: 'ai-text',
				reason: 'Neutral free-form text is the first candidate for AI-backed extraction.',
			};
		}

		return {
			providerKind: 'rule-based',
			route: 'rule-text',
			reason: 'Explicit structured text stays on the deterministic rule-based path.',
		};
	}

	routeReceiptRequest(request: FinanceReceiptProposalRequest): FinanceIntakeRoutingDecision {
		if (this.isPdfRequest(request)) {
			return {
				providerKind: 'ai',
				route: 'ai-pdf',
				reason: 'Text-based PDF finance documents use local text extraction first and AI normalization second.',
			};
		}

		if (this.isAiTextEnabled()) {
			return {
				providerKind: 'ai',
				route: 'ai-image',
				reason: 'Image receipt and banking screenshots use QR extraction first, then AI fallback if deterministic parsing fails.',
			};
		}

		return {
			providerKind: 'rule-based',
			route: 'rule-qr',
			reason: 'Image-based receipt input currently stays on the QR-oriented deterministic path.',
		};
	}

	private looksSimpleStructuredText(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) {
			return false;
		}

		if (/^\/?(expense|income)\s+[-+]?\d+([.,]\d+)?\s+\S+/i.test(trimmed)) {
			return true;
		}

		if (/^[-+]?\d+([.,]\d+)?\s+\S+/.test(trimmed)) {
			return true;
		}

		return false;
	}

	private isAiTextEnabled(): boolean {
		return Boolean(
			this.settings.enableAiFinanceTextIntake
			&& this.settings.aiFinanceApiBaseUrl.trim()
			&& this.settings.aiFinanceApiKey.trim()
			&& this.settings.aiFinanceModel.trim(),
		);
	}

	private isPdfRequest(request: FinanceReceiptProposalRequest): boolean {
		return Boolean(
			request.mimeType?.toLowerCase() === 'application/pdf'
			|| request.fileName.toLowerCase().endsWith('.pdf'),
		);
	}
}
