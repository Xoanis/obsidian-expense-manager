import * as assert from 'node:assert/strict';

import {
	isEmailFinanceRebuildProviderCompatible,
	resolveRebuiltEmailMessageId,
} from '../src/email-finance/sync/email-finance-rebuild-compat';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('rebuild accepts legacy imap notes after migrating to workspace email-provider', () => {
	assert.equal(
		isEmailFinanceRebuildProviderCompatible('imap', 'email-provider'),
		true,
	);
});

run('rebuild still rejects incompatible non-migration provider mismatches', () => {
	assert.equal(
		isEmailFinanceRebuildProviderCompatible('email-provider', 'none'),
		false,
	);
	assert.equal(
		isEmailFinanceRebuildProviderCompatible('http-json', 'email-provider'),
		false,
	);
});

run('rebuild rewrites old message ids to the canonical provider id when available', () => {
	assert.equal(
		resolveRebuiltEmailMessageId(
			{ id: 'email-provider:channel-a:123' },
			'123',
		),
		'email-provider:channel-a:123',
	);
});

run('rebuild keeps the old message id when the provider does not expose a canonical id', () => {
	assert.equal(
		resolveRebuiltEmailMessageId(
			{ id: '   ' },
			'123',
		),
		'123',
	);
});
