import type { EmailFinanceSyncState } from '../../settings';

export interface EmailFinanceSyncSummaryStats {
	totalMessages: number;
	passedCoarseFilter: number;
	filteredOut: number;
	plannedUnits: number;
	createdPendingNotes: number;
	createdNeedsAttentionNotes: number;
	createdDuplicateNotes: number;
	failedUnits: number;
	hasMore: boolean;
	maxMessagesPerRun: number;
}

export function hasMoreEmailFinanceSyncPages(nextCursor: string | null | undefined): boolean {
	return Boolean(nextCursor);
}

export function buildEmailFinanceSyncSummaryText(stats: EmailFinanceSyncSummaryStats): string {
	const summary = `Scanned ${stats.totalMessages} email(s): ${stats.passedCoarseFilter} passed coarse filter, ${stats.filteredOut} filtered out, ${stats.plannedUnits} unit(s) planned, ${stats.createdPendingNotes} pending note(s) created, ${stats.createdNeedsAttentionNotes} needs-attention note(s) created, ${stats.createdDuplicateNotes} duplicate note(s) created, ${stats.failedUnits} unit(s) failed.`;
	if (!stats.hasMore) {
		return summary;
	}

	return `${summary} Reached the per-run limit of ${stats.maxMessagesPerRun} email(s); run sync again to continue from the saved cursor.`;
}

export function buildSuccessfulEmailFinanceSyncState(options: {
	previousState: EmailFinanceSyncState;
	startedAt: string;
	nextCursor: string | null | undefined;
	summaryText: string;
}): EmailFinanceSyncState {
	const hasMore = hasMoreEmailFinanceSyncPages(options.nextCursor);
	return {
		...options.previousState,
		lastAttemptAt: options.startedAt,
		lastSuccessfulSyncAt: hasMore ? options.previousState.lastSuccessfulSyncAt : options.startedAt,
		cursor: options.nextCursor ?? null,
		lastSyncStatus: 'success',
		lastSyncSummary: options.summaryText,
	};
}
