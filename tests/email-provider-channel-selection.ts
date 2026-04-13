import * as assert from 'node:assert/strict';

import {
	buildEmailProviderChannelSelectionKey,
	parseEmailProviderChannelSelection,
} from '../src/integrations/email-provider/channel-selection';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('parses comma and newline separated email-provider channel selections', () => {
	assert.deepEqual(
		parseEmailProviderChannelSelection(' personal-imap,\nwork-gmail ; personal-imap '),
		['personal-imap', 'work-gmail'],
	);
});

run('builds a stable single-channel selection key without rewriting the original id', () => {
	assert.equal(
		buildEmailProviderChannelSelectionKey(['personal-imap']),
		'personal-imap',
	);
});

run('builds a stable multi-channel selection key from sorted unique channel ids', () => {
	assert.equal(
		buildEmailProviderChannelSelectionKey(['work-gmail', 'personal-imap', 'work-gmail']),
		'selection:personal-imap,work-gmail',
	);
});

run('encodes reserved characters when building a multi-channel selection key', () => {
	assert.equal(
		buildEmailProviderChannelSelectionKey(['sales/eu', 'personal-imap']),
		'selection:personal-imap,sales%2Feu',
	);
});
