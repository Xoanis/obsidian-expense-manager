import * as assert from 'node:assert/strict';

import { formatEmailSyncTelegramNotification } from '../src/services/telegram-email-sync-notification-format';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('formats Telegram notification for new pending email receipts', () => {
	const message = formatEmailSyncTelegramNotification({
		createdPendingNotes: 3,
		createdNeedsAttentionNotes: 1,
		totalMessages: 7,
		skippedDuplicates: 2,
		nextCursor: 'cursor-2',
	}, {
		trigger: 'scheduled',
	});

	assert.match(message, /Email finance sync \(auto\)/);
	assert.match(message, /3 new pending approval item\(s\)/);
	assert.match(message, /Needs attention: 1\./);
	assert.match(message, /Duplicates skipped: 2\./);
	assert.match(message, /More emails are waiting in the saved sync cursor\./);
	assert.match(message, /\/finance_review pending/);
});

run('keeps manual label and omits optional lines when not needed', () => {
	const message = formatEmailSyncTelegramNotification({
		createdPendingNotes: 1,
		createdNeedsAttentionNotes: 0,
		totalMessages: 1,
		skippedDuplicates: 0,
		nextCursor: null,
	}, {
		trigger: 'manual',
	});

	assert.match(message, /Email finance sync \(manual\)/);
	assert.doesNotMatch(message, /Needs attention:/);
	assert.doesNotMatch(message, /Duplicates skipped:/);
	assert.doesNotMatch(message, /saved sync cursor/);
});
