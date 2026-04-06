import type { EmailFinanceSyncState } from '../../settings';

export class EmailFinanceSyncStateStore {
	constructor(
		private readonly getStateSnapshot: () => EmailFinanceSyncState,
		private readonly persistStateSnapshot: (nextState: EmailFinanceSyncState) => Promise<void>,
	) {}

	getState(): EmailFinanceSyncState {
		return this.getStateSnapshot();
	}

	async update(patch: Partial<EmailFinanceSyncState>): Promise<EmailFinanceSyncState> {
		const nextState: EmailFinanceSyncState = {
			...this.getStateSnapshot(),
			...patch,
		};
		await this.persistStateSnapshot(nextState);
		return nextState;
	}

	async reset(): Promise<EmailFinanceSyncState> {
		const nextState: EmailFinanceSyncState = {
			lastSuccessfulSyncAt: null,
			cursor: null,
			lastAttemptAt: null,
			lastSyncStatus: 'idle',
			lastSyncSummary: null,
		};
		await this.persistStateSnapshot(nextState);
		return nextState;
	}
}
