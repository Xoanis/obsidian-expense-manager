import type { TFile } from 'obsidian';
import type { TransactionData, TransactionType } from '../../types';
import { ExpenseService } from '../../services/expense-service';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';

export class PendingFinanceProposalService {
	constructor(
		private readonly expenseService: ExpenseService,
		private readonly getDefaultCurrency: () => string = () => 'RUB',
	) {}

	async createPendingProposal(proposal: TransactionData): Promise<TFile> {
		const source = proposal.source ?? 'email';
		const normalizedTags = Array.from(new Set([
			'finance',
			proposal.type,
			source,
			'pending-approval',
			...this.normalizeProposalTags(proposal.tags ?? [], source),
		]));

		return this.expenseService.createTransaction({
			...proposal,
			source,
			status: 'pending-approval',
			tags: normalizedTags,
		});
	}

	async createNeedsAttentionProposal(options: {
		message: FinanceMailMessage;
		reason: string;
		sourceContext?: string;
		type?: TransactionType;
		currency?: string;
		artifactBytes?: ArrayBuffer;
		artifactFileName?: string;
		artifactMimeType?: string;
	}): Promise<TFile> {
		const source = 'email';
		const type = options.type ?? 'expense';
		const description = options.message.subject?.trim() || 'Email finance candidate requires attention';
		return this.expenseService.createTransaction({
			type,
			amount: 0,
			currency: options.currency ?? this.getDefaultCurrency(),
			dateTime: options.message.receivedAt || new Date().toISOString(),
			description,
			category: 'Needs Attention',
			source,
			status: 'needs-attention',
			sourceContext: options.sourceContext ?? this.buildNeedsAttentionContext(options.message, options.reason),
			artifactBytes: options.artifactBytes,
			artifactFileName: options.artifactFileName,
			artifactMimeType: options.artifactMimeType,
			tags: [
				'finance',
				type,
				source,
				'needs-attention',
			],
		});
	}

	private normalizeProposalTags(tags: string[], source: TransactionData['source']): string[] {
		const transportTags = new Set(['manual', 'telegram', 'email', 'api', 'pdf']);
		return tags.filter((tag) => {
			if (!tag || transportTags.has(tag)) {
				return false;
			}
			if (tag === source) {
				return false;
			}
			return true;
		});
	}

	private buildNeedsAttentionContext(message: FinanceMailMessage, reason: string): string {
		const lines = [
			`- Reason: ${reason}`,
			`- Message ID: ${message.id}`,
			message.threadId ? `- Thread ID: ${message.threadId}` : '',
			message.from ? `- From: ${message.from}` : '',
			message.subject ? `- Subject: ${message.subject}` : '',
			message.receivedAt ? `- Received At: ${message.receivedAt}` : '',
			message.attachmentNames.length > 0
				? `- Attachments: ${message.attachmentNames.join(', ')}`
				: '- Attachments: none',
		].filter(Boolean);
		return lines.join('\n');
	}
}
