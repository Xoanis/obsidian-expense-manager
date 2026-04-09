import { App, TFile } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import { TransactionType } from '../types';
import { upsertItemsSection, parseYamlFrontmatter } from '../utils/frontmatter';
import { ProverkaChekaClient } from '../utils/api-client';
import { buildRawReceiptQrCandidates } from '../utils/qr-parser';

interface ReceiptEnrichmentResult {
	file: TFile;
	itemCount: number;
	attemptCount: number;
}

export class ReceiptEnrichmentService {
	constructor(
		private readonly app: App,
		private readonly settings: ExpenseManagerSettings,
	) {}

	canEnrichFile(file: TFile | null): boolean {
		if (!file) {
			return false;
		}

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) {
			return false;
		}

		const transactionType = normalizeFinanceTransactionType(frontmatter.type);
		if (!transactionType) {
			return false;
		}

		return hasLookupPrerequisites(frontmatter);
	}

	async enrichFile(file: TFile): Promise<ReceiptEnrichmentResult> {
		if (!this.settings.proverkaChekaApiKey?.trim()) {
			throw new Error('ProverkaCheka API token is not configured');
		}

		const content = await this.app.vault.cachedRead(file);
		const frontmatter = parseYamlFrontmatter(content);
		if (!frontmatter) {
			throw new Error('The note does not contain frontmatter');
		}

		const transactionType = normalizeFinanceTransactionType(frontmatter.type);
		if (!transactionType) {
			throw new Error('The active note is not a finance transaction note');
		}

		const qrCandidates = buildRawReceiptQrCandidates({
			type: transactionType,
			amount: Number(frontmatter.amount),
			dateTime: typeof frontmatter.dateTime === 'string' ? frontmatter.dateTime : String(frontmatter.date ?? ''),
			fn: typeof frontmatter.fn === 'string' ? frontmatter.fn : '',
			fd: typeof frontmatter.fd === 'string' ? frontmatter.fd : '',
			fp: typeof frontmatter.fp === 'string' ? frontmatter.fp : '',
			receiptOperationType: normalizeReceiptOperationType(frontmatter.receiptOperationType),
		});
		if (qrCandidates.length === 0) {
			throw new Error('Could not build receipt QR payload from note frontmatter');
		}

		const client = new ProverkaChekaClient(this.settings.proverkaChekaApiKey, false);
		const errors: string[] = [];
		let result: Awaited<ReturnType<ProverkaChekaClient['processReceiptQrStringViaApi']>> | null = null;

		for (const candidate of qrCandidates) {
			try {
				result = await client.processReceiptQrStringViaApi(candidate);
				break;
			} catch (error) {
				errors.push((error as Error).message);
			}
		}

		if (!result) {
			throw new Error(errors.filter(Boolean).join(' | ') || 'Failed to retrieve receipt details');
		}

		const nextContent = upsertItemsSection(content, result.details ?? []);
		if (nextContent !== content) {
			await this.app.vault.modify(file, nextContent);
		}

		await this.app.fileManager.processFrontMatter(file, (mutableFrontmatter) => {
			mutableFrontmatter.ProverkaCheka = true;
			if (result?.receiptOperationType) {
				mutableFrontmatter.receiptOperationType = result.receiptOperationType;
			}
		});

		return {
			file,
			itemCount: result.details?.length ?? 0,
			attemptCount: qrCandidates.length,
		};
	}
}

function normalizeFinanceTransactionType(value: unknown): TransactionType | null {
	if (value === 'expense' || value === 'finance-expense') {
		return 'expense';
	}
	if (value === 'income' || value === 'finance-income') {
		return 'income';
	}

	return null;
}

function hasLookupPrerequisites(frontmatter: Record<string, unknown>): boolean {
	if (!Number.isFinite(Number(frontmatter.amount))) {
		return false;
	}

	const dateTime = typeof frontmatter.dateTime === 'string' ? frontmatter.dateTime : frontmatter.date;
	return typeof dateTime === 'string'
		&& typeof frontmatter.fn === 'string'
		&& typeof frontmatter.fd === 'string'
		&& typeof frontmatter.fp === 'string';
}

function normalizeReceiptOperationType(value: unknown): 1 | 2 | 3 | 4 | undefined {
	if (value === 1 || value === 2 || value === 3 || value === 4) {
		return value;
	}

	return undefined;
}
