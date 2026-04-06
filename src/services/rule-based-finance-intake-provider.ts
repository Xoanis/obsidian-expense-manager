import { ExpenseManagerSettings } from '../settings';
import { TransactionData, TransactionType } from '../types';
import { ProverkaChekaClient } from '../utils/api-client';
import { looksLikeRawReceiptQrString } from '../utils/qr-parser';
import type {
	FinanceCaptionMetadata,
	FinanceIntakeIntent,
	FinanceIntakeProvider,
	FinanceMetadataHints,
	FinanceReceiptProposalRequest,
	FinanceReceiptProposalResult,
	FinanceTextProposalRequest,
} from './finance-intake-types';

interface ParsedTelegramTransactionInput extends FinanceMetadataHints {
	amount: number;
	comment: string;
}

interface ParsedFlexibleTelegramTransactionInput extends ParsedTelegramTransactionInput {
	transactionType: TransactionType;
}

export class RuleBasedFinanceIntakeProvider implements FinanceIntakeProvider {
	constructor(private readonly settings: ExpenseManagerSettings) {}

	async createTextTransaction(
		request: FinanceTextProposalRequest,
	): Promise<TransactionData | null> {
		const qrTextResult = await this.createReceiptTransactionFromQrText(request);
		if (qrTextResult) {
			return qrTextResult;
		}

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
			description: result.data.description,
			artifactBytes: request.bytes,
			artifactFileName: request.fileName,
			artifactMimeType: request.mimeType,
		};

		return {
			data,
			source: result.source,
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

	private async createReceiptTransactionFromQrText(
		request: FinanceTextProposalRequest,
	): Promise<TransactionData | null> {
		const { head, metadata } = this.splitHeadAndMetadata(request.text);
		const normalizedHead = head.trim();
		if (!looksLikeRawReceiptQrString(normalizedHead)) {
			return null;
		}

		const client = new ProverkaChekaClient(
			this.settings.proverkaChekaApiKey,
			this.settings.localQrOnly,
		);
		const result = await client.processReceiptQrString(normalizedHead);
		if (result.hasError || result.data.amount <= 0) {
			return null;
		}

		return {
			...result.data,
			type: request.intent === 'neutral' ? result.data.type : request.intent,
			source: request.source ?? 'telegram',
			area: request.area ?? metadata.area,
			project: request.project ?? metadata.project,
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
		const { head, metadata } = this.splitHeadAndMetadata(args);
		if (!head) {
			return null;
		}

		const [amountStr, ...commentParts] = head.split(/\s+/);
		const amount = parseFloat(amountStr);
		const comment = commentParts.join(' ').trim();
		if (Number.isNaN(amount) || !comment) {
			return null;
		}

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

	private splitHeadAndMetadata(value: string): { head: string; metadata: FinanceMetadataHints } {
		const parts = value
			.split('|')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return { head: '', metadata: {} };
		}

		const [head, ...metadataParts] = parts;
		return {
			head,
			metadata: this.parseMetadataParts(metadataParts),
		};
	}

	private normalizeWikiLink(value: string): string {
		const trimmed = value.trim();
		if (/^\[\[.*\]\]$/.test(trimmed)) {
			return trimmed;
		}
		return `[[${trimmed}]]`;
	}
}
