import type { EmailFinanceSyncSummary } from '../email-finance/sync/email-finance-sync-service';

export interface TelegramEmailSyncNotificationOptions {
	trigger: 'manual' | 'scheduled';
}

export function formatEmailSyncTelegramNotification(
	summary: Pick<
		EmailFinanceSyncSummary,
		| 'createdPendingNotes'
		| 'createdNeedsAttentionNotes'
		| 'totalMessages'
		| 'skippedDuplicates'
		| 'nextCursor'
	>,
	options: TelegramEmailSyncNotificationOptions,
): string {
	const lines = [
		`📬 Email finance sync (${options.trigger === 'scheduled' ? 'auto' : 'manual'})`,
		'',
		`${summary.createdPendingNotes} new pending approval item(s) were created from email receipts.`,
		`Scanned emails: ${summary.totalMessages}.`,
	];

	if (summary.createdNeedsAttentionNotes > 0) {
		lines.push(`Needs attention: ${summary.createdNeedsAttentionNotes}.`);
	}
	if (summary.skippedDuplicates > 0) {
		lines.push(`Duplicates skipped: ${summary.skippedDuplicates}.`);
	}
	if (summary.nextCursor) {
		lines.push('More emails are waiting in the saved sync cursor.');
	}

	lines.push('');
	lines.push('Review queue: /finance_review pending');
	lines.push('All review items: /finance_review');
	return lines.join('\n');
}
