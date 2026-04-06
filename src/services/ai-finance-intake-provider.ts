import { requestUrl } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import { TransactionData } from '../types';
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
import {
	buildAiFinancePdfSystemPrompt,
	buildAiFinancePdfUserPayload,
	buildAiFinanceReceiptSystemPrompt,
	buildAiFinanceReceiptUserContent,
	buildAiFinanceSystemPrompt,
	buildAiFinanceTextUserPayload,
	parseAiFinanceJsonObject,
} from './ai-finance-intake-prompts';
import { normalizeAiFinanceExtractionResult } from './ai-finance-intake-normalization';
import type {
	FinanceIntakeProvider,
	FinanceReceiptProposalRequest,
	FinanceReceiptProposalResult,
	FinanceTextProposalRequest,
} from './finance-intake-types';

interface OpenAiCompatibleChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
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
			return this.createNotImplementedResult('ai-text', this.getTextSource(), [
				'AI finance text extraction is not configured.',
			]);
		}

		try {
			const parsed = await this.requestJsonChatCompletion([
				{
					role: 'system',
					content: buildAiFinanceSystemPrompt(),
				},
				{
					role: 'user',
					content: JSON.stringify(buildAiFinanceTextUserPayload(this.settings, request)),
				},
			], 'AiFinanceIntakeProvider.extractText', {
				intent: request.intent,
				textLength: request.text.length,
			});
			const result = normalizeAiFinanceExtractionResult(this.settings, parsed, {
				intent: request.intent,
				route: 'ai-text',
				source: this.getTextSource(),
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
			return this.createNotImplementedResult('ai-text', this.getTextSource(), [
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
		const route: FinanceIntakeRoute = 'ai-image';
		const source: FinanceProposalSource = 'telegram-image';
		if (!this.isConfigured()) {
			this.logger.warn('AiFinanceIntakeProvider.extractReceipt: AI receipt extraction is not configured.');
			return this.createNotImplementedResult(route, source, [
				'AI finance receipt extraction is not configured.',
			]);
		}

		const artifactDataUrl = this.toDataUrl(request.bytes, request.mimeType || 'image/jpeg');
		if (!artifactDataUrl) {
			return this.createNotImplementedResult(route, source, [
				'Receipt artifact is too large for inline AI processing. Try a smaller image.',
			]);
		}

		try {
			const parsed = await this.requestJsonChatCompletion([
				{
					role: 'system',
					content: buildAiFinanceReceiptSystemPrompt(),
				},
				{
					role: 'user',
					content: buildAiFinanceReceiptUserContent(this.settings, request, artifactDataUrl),
				},
			], 'AiFinanceIntakeProvider.extractReceipt', {
				intent: request.intent,
				fileName: request.fileName,
				mimeType: request.mimeType,
				byteLength: request.bytes.byteLength,
				route,
			});
			const result = normalizeAiFinanceExtractionResult(this.settings, parsed, {
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
					content: buildAiFinancePdfSystemPrompt(),
				},
				{
					role: 'user',
					content: JSON.stringify(buildAiFinancePdfUserPayload(this.settings, request, extraction)),
				},
			], 'AiFinanceIntakeProvider.extractPdfReceipt', {
				intent: request.intent,
				fileName: request.fileName,
				mimeType: request.mimeType,
				textLength: extraction.text.length,
				pageCount: extraction.pages.length,
				warnings: extraction.warnings,
			});
			const result = normalizeAiFinanceExtractionResult(this.settings, parsed, {
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
		const requestBody = {
			model: this.settings.aiFinanceModel,
			temperature: 0.1,
			response_format: {
				type: 'json_object',
			},
			messages,
		};
		const loggableRequestBody = this.toLoggableRequestBody(requestBody);
		const serializedRequestBody = JSON.stringify(loggableRequestBody);

		this.logger.info(`${logLabel}: sending request`, {
			model: this.settings.aiFinanceModel,
			baseUrl: this.settings.aiFinanceApiBaseUrl,
			requestPayloadLength: serializedRequestBody.length,
			requestPayloadPreview: serializedRequestBody.slice(0, 4000),
			...logContext,
		});
		this.logger.debug(`${logLabel}: request payload`, {
			requestPayload: serializedRequestBody,
		});

		const response = await requestUrl({
			url: this.getChatCompletionsUrl(),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.settings.aiFinanceApiKey}`,
			},
			body: JSON.stringify(requestBody),
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
		return parseAiFinanceJsonObject(content);
	}

	private toLoggableRequestBody(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map((item) => this.toLoggableRequestBody(item));
		}

		if (!value || typeof value !== 'object') {
			return value;
		}

		const record = value as Record<string, unknown>;
		if (record.type === 'image_url' && record.image_url && typeof record.image_url === 'object') {
			const imageUrl = record.image_url as Record<string, unknown>;
			const url = typeof imageUrl.url === 'string' ? imageUrl.url : '';
			return {
				...record,
				image_url: {
					...imageUrl,
					url: this.toLoggableImageUrl(url),
				},
			};
		}

		const result: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(record)) {
			result[key] = this.toLoggableRequestBody(nestedValue);
		}
		return result;
	}

	private toLoggableImageUrl(url: string): string {
		if (!url.startsWith('data:')) {
			return url;
		}

		const commaIndex = url.indexOf(',');
		const header = commaIndex >= 0 ? url.slice(0, commaIndex) : url;
		return `${header},<omitted;base64-length=${Math.max(url.length - header.length - 1, 0)}>`;
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

	private getTextSource(): FinanceProposalSource {
		return 'telegram-text';
	}
}
