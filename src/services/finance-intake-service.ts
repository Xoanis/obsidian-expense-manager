import { ExpenseManagerSettings } from '../settings';
import { TransactionData } from '../types';
import { ConsolePluginLogger, PluginLogger } from '../utils/plugin-debug-log';
import {
	createDefaultDocumentExtractionService,
	DocumentExtractionService,
	isUsableDocumentExtractionResult,
} from './document-extraction-service';
import { AiFinanceIntakeProvider } from './ai-finance-intake-provider';
import { RuleBasedFinanceIntakeProvider } from './rule-based-finance-intake-provider';
import { looksLikeRawReceiptQrString } from '../utils/qr-parser';
import { buildRawReceiptQrPayload, extractFiscalReceiptFields } from '../email-finance/parsers/email-finance-message-parsers';
import type {
	FinanceCaptionMetadata,
	FinanceIntakeProvider,
	FinanceIntakeRoutingDecision,
	FinanceMetadataHints,
	FinanceReceiptProposalRequest,
	FinanceReceiptProposalResult,
	FinanceTextProposalRequest,
} from './finance-intake-types';

export type {
	FinanceCaptionMetadata,
	FinanceIntakeIntent,
	FinanceIntakeProvider,
	FinanceIntakeRoutingDecision,
	FinanceMetadataHints,
	FinanceReceiptProposalRequest,
	FinanceReceiptProposalResult,
	FinanceTextProposalRequest,
} from './finance-intake-types';

export { AiFinanceIntakeProvider } from './ai-finance-intake-provider';
export { RuleBasedFinanceIntakeProvider } from './rule-based-finance-intake-provider';

interface FinanceIntakeServiceOptions {
	ruleProvider?: FinanceIntakeProvider;
	aiProvider?: FinanceIntakeProvider;
	documentExtractionService?: DocumentExtractionService;
	logger?: PluginLogger;
}

export class FinanceIntakeService {
	private readonly ruleProvider: FinanceIntakeProvider;
	private readonly aiProvider: FinanceIntakeProvider;
	private readonly documentExtractionService: DocumentExtractionService;
	private readonly logger: PluginLogger;

	constructor(
		private readonly settings: ExpenseManagerSettings,
		options?: FinanceIntakeServiceOptions,
	) {
		this.logger = options?.logger ?? new ConsolePluginLogger();
		this.documentExtractionService = options?.documentExtractionService ?? createDefaultDocumentExtractionService();
		this.ruleProvider = options?.ruleProvider ?? new RuleBasedFinanceIntakeProvider(settings);
		this.aiProvider = options?.aiProvider ?? new AiFinanceIntakeProvider(
			settings,
			this.documentExtractionService,
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
		if (this.isPdfRequest(request)) {
			const localPdfResult = await this.tryCreatePdfTextBasedProposal(request);
			if (localPdfResult) {
				this.logger.info('FinanceIntakeService.createReceiptProposal: local PDF text extraction produced a deterministic transaction before AI fallback was needed.');
				return this.applyReceiptCaptionContext(localPdfResult, request);
			}
		}

		if (!this.isPdfRequest(request) && this.isAiTextEnabled()) {
			try {
				const ruleResult = this.applyReceiptCaptionContext(
					await this.ruleProvider.createReceiptTransaction(request),
					request,
				);
				this.logger.info('FinanceIntakeService.createReceiptProposal: rule-based receipt extraction succeeded before AI fallback was needed.');
				return ruleResult;
			} catch (error) {
				this.logger.warn('FinanceIntakeService.createReceiptProposal: rule-based receipt extraction failed, trying AI fallback.', error);
			}
		}

		if (decision.providerKind === 'ai') {
			try {
				return this.applyReceiptCaptionContext(
					await this.aiProvider.createReceiptTransaction(request),
					request,
				);
			} catch (error) {
				if (!this.isPdfRequest(request)) {
					return this.applyReceiptCaptionContext(
						await this.ruleProvider.createReceiptTransaction(request),
						request,
					);
				}
				throw error;
			}
		}

		return this.applyReceiptCaptionContext(
			await this.ruleProvider.createReceiptTransaction(request),
			request,
		);
	}

	private async tryCreatePdfTextBasedProposal(
		request: FinanceReceiptProposalRequest,
	): Promise<FinanceReceiptProposalResult | null> {
		try {
			const extraction = await this.documentExtractionService.extractPdf({
				bytes: request.bytes,
				fileName: request.fileName,
				mimeType: request.mimeType,
			});
			this.logger.info('FinanceIntakeService.tryCreatePdfTextBasedProposal: document extraction result', {
				status: extraction.status,
				textLength: extraction.text.length,
				pageCount: extraction.pages.length,
				warnings: extraction.warnings,
				provider: extraction.provider,
				textPreview: extraction.text.slice(0, 800),
			});
			if (!isUsableDocumentExtractionResult(extraction)) {
				return null;
			}

			const qrPayload = this.extractReceiptQrPayloadFromDocumentText(extraction.text, request.caption);
			if (!qrPayload) {
				return null;
			}

			const transaction = await this.ruleProvider.createTextTransaction({
				text: qrPayload,
				intent: request.intent,
				source: request.source,
				area: request.area,
				project: request.project,
			});
			if (!transaction || transaction.amount <= 0) {
				return null;
			}

			return {
				source: 'local',
				data: {
					...transaction,
					artifactBytes: request.bytes,
					artifactFileName: request.fileName,
					artifactMimeType: request.mimeType,
				},
			};
		} catch (error) {
			this.logger.warn('FinanceIntakeService.tryCreatePdfTextBasedProposal: local PDF text extraction failed, falling back to regular receipt flow.', error);
			return null;
		}
	}

	parseCaption(caption: string): FinanceCaptionMetadata {
		return this.ruleProvider.parseCaption?.(caption) ?? { comment: '' };
	}

	extractMetadataHints(value: string): FinanceMetadataHints {
		return this.ruleProvider.extractMetadataHints?.(value) ?? {};
	}

	getSettings(): ExpenseManagerSettings {
		return this.settings;
	}

	routeTextRequest(request: FinanceTextProposalRequest): FinanceIntakeRoutingDecision {
		if (this.looksLikeReceiptQrText(request.text)) {
			return {
				providerKind: 'rule-based',
				route: 'rule-qr',
				reason: 'Raw receipt QR text stays on the deterministic QR lookup path.',
			};
		}

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
		const trimmed = this.getPrimaryTextPayload(text);
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

	private looksLikeReceiptQrText(text: string): boolean {
		return looksLikeRawReceiptQrString(this.getPrimaryTextPayload(text));
	}

	private extractReceiptQrPayloadFromDocumentText(text: string, caption?: string): string | null {
		const primaryPayload = this.getPrimaryTextPayload(text);
		if (looksLikeRawReceiptQrString(primaryPayload)) {
			return primaryPayload;
		}

		const textCandidates = [
			text,
			caption ? `${text}\n\n${caption}` : '',
			caption ?? '',
		].filter(Boolean);

		for (const candidate of textCandidates) {
			const receiptFields = extractFiscalReceiptFields(candidate);
			if (receiptFields) {
				return buildRawReceiptQrPayload(receiptFields);
			}
		}

		return null;
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

	private getPrimaryTextPayload(text: string): string {
		return text.split('|')[0]?.trim() ?? '';
	}

	private applyReceiptCaptionContext(
		result: FinanceReceiptProposalResult,
		request: FinanceReceiptProposalRequest,
	): FinanceReceiptProposalResult {
		const captionMetadata = this.parseCaption(request.caption || '');
		result.data.area = captionMetadata.area ?? result.data.area ?? request.area ?? undefined;
		result.data.project = captionMetadata.project ?? result.data.project ?? request.project ?? undefined;
		result.data.description = this.mergeDescriptionWithCaption(
			result.data.description,
			captionMetadata,
		) || result.data.description || 'Receipt';
		return result;
	}

	private mergeDescriptionWithCaption(
		description: string | undefined,
		captionMetadata: FinanceCaptionMetadata,
	): string | undefined {
		const base = description?.trim() ?? '';
		const comment = captionMetadata.comment?.trim() ?? '';
		if (!comment) {
			return base || undefined;
		}
		if (!base) {
			return comment;
		}

		const normalizedBase = base.toLocaleLowerCase();
		const normalizedComment = comment.toLocaleLowerCase();
		if (normalizedBase.includes(normalizedComment) || normalizedComment.includes(normalizedBase)) {
			return base;
		}

		return `${base} - ${comment}`;
	}
}
