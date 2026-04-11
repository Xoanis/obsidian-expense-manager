import * as assert from 'node:assert/strict';

import {
	buildEmailFinanceSyncSummaryText,
	buildSuccessfulEmailFinanceSyncState,
	hasMoreEmailFinanceSyncPages,
} from '../src/email-finance/sync/email-finance-sync-progress';
import type { EmailFinanceSyncState } from '../src/settings';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('email sync summary mentions saved cursor when more pages remain', () => {
	const summary = buildEmailFinanceSyncSummaryText({
		totalMessages: 2,
		passedCoarseFilter: 2,
		filteredOut: 0,
		plannedUnits: 0,
		createdPendingNotes: 0,
		createdNeedsAttentionNotes: 2,
		failedUnits: 0,
		skippedDuplicates: 0,
		hasMore: true,
		maxMessagesPerRun: 20,
	});

	assert.match(summary, /Reached the per-run limit of 20 email\(s\)/);
});

run('email sync keeps previous successful boundary while cursor pagination is in progress', () => {
	const previousState: EmailFinanceSyncState = {
		lastSuccessfulSyncAt: '2026-04-01T08:00:00.000Z',
		cursor: null,
		lastAttemptAt: '2026-04-01T08:00:00.000Z',
		lastSyncStatus: 'success',
		lastSyncSummary: 'Previous summary',
	};

	const nextState = buildSuccessfulEmailFinanceSyncState({
		previousState,
		startedAt: '2026-04-10T09:30:00.000Z',
		nextCursor: 'page-2',
		summaryText: 'Paged sync summary',
	});

	assert.equal(hasMoreEmailFinanceSyncPages('page-2'), true);
	assert.equal(nextState.lastSuccessfulSyncAt, previousState.lastSuccessfulSyncAt);
	assert.equal(nextState.cursor, 'page-2');
	assert.equal(nextState.lastSyncStatus, 'success');
	assert.equal(nextState.lastSyncSummary, 'Paged sync summary');
});

run('email sync clears cursor and advances boundary after the final page', () => {
	const previousState: EmailFinanceSyncState = {
		lastSuccessfulSyncAt: null,
		cursor: 'page-2',
		lastAttemptAt: '2026-04-10T09:00:00.000Z',
		lastSyncStatus: 'success',
		lastSyncSummary: 'Partial sync summary',
	};

	const nextState = buildSuccessfulEmailFinanceSyncState({
		previousState,
		startedAt: '2026-04-10T10:00:00.000Z',
		nextCursor: null,
		summaryText: 'Completed sync summary',
	});

	assert.equal(hasMoreEmailFinanceSyncPages(null), false);
	assert.equal(nextState.cursor, null);
	assert.equal(nextState.lastSuccessfulSyncAt, '2026-04-10T10:00:00.000Z');
	assert.equal(nextState.lastSyncSummary, 'Completed sync summary');
});
