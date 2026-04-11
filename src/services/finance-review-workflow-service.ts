import type { TFile } from 'obsidian';
import type { ExpenseManagerSettings } from '../settings';
import { ExpenseService } from './expense-service';

export type RejectedReviewDisposition = 'archived' | 'deleted';

export interface RejectStoredReviewItemResult {
	disposition: RejectedReviewDisposition;
	file?: TFile;
}

export class FinanceReviewWorkflowService {
	constructor(
		private readonly expenseService: ExpenseService,
		private readonly getSettings: () => Pick<ExpenseManagerSettings, 'archiveRejectedTransactions'>,
	) {}

	async rejectStoredReviewItem(file: TFile): Promise<RejectStoredReviewItemResult> {
		if (this.getSettings().archiveRejectedTransactions) {
			const archivedFile = await this.expenseService.archiveTransactionAsRejected(file);
			return {
				disposition: 'archived',
				file: archivedFile,
			};
		}

		await this.expenseService.deleteTransaction(file);
		return {
			disposition: 'deleted',
		};
	}
}
