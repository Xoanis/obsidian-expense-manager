import * as assert from 'node:assert/strict';

import { normalizeExpenseManagerSettings } from '../src/settings';

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

function createRawSettings(provider: 'none' | 'imap' | 'http-json' | 'email-provider') {
	return {
		emailFinanceProvider: provider,
		emailFinanceMailboxScope: 'INBOX',
		emailFinanceProviderBaseUrl: 'https://mail-bridge.example.com',
		emailFinanceProviderAuthToken: 'token',
		emailFinanceProviderChannelId: '',
		emailFinanceImapHost: 'imap.gmail.com',
		emailFinanceImapPort: 993,
		emailFinanceImapSecure: true,
		emailFinanceImapUser: 'user@example.com',
		emailFinanceImapPassword: 'app-password',
	} as const;
}

export default async function runEmailFinanceProviderModeTests(): Promise<void> {
	await run('legacy IMAP settings are normalized into workspace email-provider mode', async () => {
		const result = normalizeExpenseManagerSettings(createRawSettings('imap'));
		assert.equal(result.settings.emailFinanceProvider, 'email-provider');
		assert.equal(result.normalizedLegacyEmailFinanceProvider, 'imap');
		for (const key of [
			'emailFinanceMailboxScope',
			'emailFinanceImapHost',
			'emailFinanceImapPassword',
			'emailFinanceImapPort',
			'emailFinanceImapSecure',
			'emailFinanceImapUser',
			'emailFinanceProviderAuthToken',
			'emailFinanceProviderBaseUrl',
		]) {
			assert.ok(result.removedLegacyEmailFinanceConfigKeys.includes(key));
		}
	});

	await run('legacy HTTP bridge settings are normalized into workspace email-provider mode', async () => {
		const result = normalizeExpenseManagerSettings(createRawSettings('http-json'));
		assert.equal(result.settings.emailFinanceProvider, 'email-provider');
		assert.equal(result.normalizedLegacyEmailFinanceProvider, 'http-json');
		assert.ok(result.removedLegacyEmailFinanceConfigKeys.includes('emailFinanceMailboxScope'));
		assert.ok(result.removedLegacyEmailFinanceConfigKeys.includes('emailFinanceProviderBaseUrl'));
		assert.ok(result.removedLegacyEmailFinanceConfigKeys.includes('emailFinanceProviderAuthToken'));
	});

	await run('supported email-provider mode stays unchanged during normalization', async () => {
		const result = normalizeExpenseManagerSettings(createRawSettings('email-provider'));
		assert.equal(result.settings.emailFinanceProvider, 'email-provider');
		assert.equal(result.normalizedLegacyEmailFinanceProvider, null);
	});
}
