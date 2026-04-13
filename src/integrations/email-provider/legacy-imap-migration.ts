import type { App } from 'obsidian';
import type { EmailFinanceSyncState, ExpenseManagerSettings } from '../../settings';
import { buildEmailFinanceCheckpointKey } from '../../email-finance/sync/email-finance-sync-state-store';
import type { PluginLogger } from '../../utils/plugin-debug-log';
import {
	EMAIL_PROVIDER_PLUGIN_ID,
	type IEmailProviderApi,
	type MailConsumerCheckpoint,
	type MailConsumerCheckpointKey,
} from './types';
import { getEmailProviderApi } from './client';

interface EmailProviderMigrationChannelRecord {
	id: string;
	name: string;
	enabled: boolean;
	config: {
		kind: 'imap';
		host: string;
		port: number;
		secure: boolean;
		user: string;
		password: string;
		mailbox: string;
	};
}

interface EmailProviderMigrationPluginLike {
	settings?: {
		channels?: EmailProviderMigrationChannelRecord[];
	};
	upsertChannel?: (
		channel: EmailProviderMigrationChannelRecord,
		options?: { makeDefault?: boolean },
	) => Promise<void>;
}

interface EmailProviderMigrationPluginResolved {
	settings?: {
		channels?: EmailProviderMigrationChannelRecord[];
	};
	upsertChannel: (
		channel: EmailProviderMigrationChannelRecord,
		options?: { makeDefault?: boolean },
	) => Promise<void>;
}

export interface LegacyImapMigrationResult {
	channelId: string;
	channelCreated: boolean;
	checkpointMigrated: boolean;
}

export async function migrateLegacyImapSettingsToEmailProvider(
	app: App,
	settings: Pick<
		ExpenseManagerSettings,
		| 'emailFinanceProvider'
		| 'emailFinanceProviderChannelId'
		| 'emailFinanceMailboxScope'
		| 'emailFinanceImapHost'
		| 'emailFinanceImapPort'
		| 'emailFinanceImapSecure'
		| 'emailFinanceImapUser'
		| 'emailFinanceImapPassword'
		| 'emailFinanceSyncState'
	>,
	logger?: PluginLogger,
): Promise<LegacyImapMigrationResult> {
	const plugin = requireEmailProviderMigrationPlugin(app);
	const api = requireEmailProviderApi(app);
	validateLegacyImapSettings(settings);

	const currentChannels = plugin.settings?.channels;
	const existingChannels = Array.isArray(currentChannels)
		? currentChannels
		: [];
	const targetChannelId = resolveTargetChannelId(
		existingChannels,
		settings.emailFinanceProviderChannelId,
	);
	const existingChannel = existingChannels.find((channel) => channel.id === targetChannelId) ?? null;
	const mailbox = settings.emailFinanceMailboxScope.trim() || 'INBOX';

	await plugin.upsertChannel({
		id: targetChannelId,
		name: existingChannel?.name?.trim() || 'Expense Manager IMAP',
		enabled: true,
		config: {
			kind: 'imap',
			host: settings.emailFinanceImapHost.trim(),
			port: settings.emailFinanceImapPort,
			secure: settings.emailFinanceImapSecure,
			user: settings.emailFinanceImapUser.trim(),
			password: settings.emailFinanceImapPassword,
			mailbox,
		},
	}, {
		makeDefault: false,
	});

	const checkpointMigrated = settings.emailFinanceProvider === 'email-provider'
		? false
		: await migrateLegacySyncBoundaryToCheckpoint(
			api,
			targetChannelId,
			settings.emailFinanceMailboxScope,
			settings.emailFinanceSyncState,
			logger,
		);

	return {
		channelId: targetChannelId,
		channelCreated: !existingChannel,
		checkpointMigrated,
	};
}

function requireEmailProviderMigrationPlugin(app: App): EmailProviderMigrationPluginResolved {
	// @ts-ignore - plugin registry is runtime-provided by Obsidian.
	const plugin = app.plugins?.plugins?.[EMAIL_PROVIDER_PLUGIN_ID] as EmailProviderMigrationPluginLike | undefined;
	if (!plugin || typeof plugin.upsertChannel !== 'function') {
		throw new Error(
			'The installed email-provider plugin does not expose the migration helper yet. Update or reload the plugin and try again.',
		);
	}

	return plugin as EmailProviderMigrationPluginResolved;
}

function requireEmailProviderApi(app: App): IEmailProviderApi {
	const api = getEmailProviderApi(app);
	if (!api) {
		throw new Error(
			'The workspace email-provider plugin is not available. Install and enable "obsidian-email-provider", then try again.',
		);
	}

	return api;
}

function validateLegacyImapSettings(
	settings: Pick<
		ExpenseManagerSettings,
		| 'emailFinanceImapHost'
		| 'emailFinanceImapPort'
		| 'emailFinanceImapUser'
		| 'emailFinanceImapPassword'
	>,
): void {
	if (!settings.emailFinanceImapHost.trim()) {
		throw new Error('Legacy IMAP host is empty.');
	}
	if (!Number.isInteger(settings.emailFinanceImapPort) || settings.emailFinanceImapPort <= 0) {
		throw new Error('Legacy IMAP port must be a positive integer.');
	}
	if (!settings.emailFinanceImapUser.trim()) {
		throw new Error('Legacy IMAP username is empty.');
	}
	if (!settings.emailFinanceImapPassword.trim()) {
		throw new Error('Legacy IMAP app password is empty.');
	}
}

function resolveTargetChannelId(
	existingChannels: EmailProviderMigrationChannelRecord[],
	requestedChannelId: string,
): string {
	const normalizedRequested = requestedChannelId.trim();
	if (normalizedRequested) {
		return normalizedRequested;
	}

	const existingIds = new Set(existingChannels.map((channel) => channel.id));
	const baseId = 'expense-manager-imap';
	if (!existingIds.has(baseId)) {
		return baseId;
	}

	let index = 2;
	let candidate = `${baseId}-${index}`;
	while (existingIds.has(candidate)) {
		index += 1;
		candidate = `${baseId}-${index}`;
	}

	return candidate;
}

async function migrateLegacySyncBoundaryToCheckpoint(
	api: IEmailProviderApi,
	channelId: string,
	mailboxScope: string,
	state: EmailFinanceSyncState,
	logger?: PluginLogger,
): Promise<boolean> {
	if (!hasMeaningfulLocalState(state)) {
		return false;
	}

	const key = buildEmailFinanceCheckpointKey(channelId, mailboxScope);
	const existingCheckpoint = await api.getCheckpoint(key);
	if (hasMeaningfulCheckpoint(existingCheckpoint)) {
		logger?.info('Skipping legacy email sync checkpoint migration because provider checkpoint already exists', {
			channelId,
			scopeFingerprint: key.scopeFingerprint ?? null,
		});
		return false;
	}

	await api.saveCheckpoint(toCheckpoint(key, state));
	return true;
}

function hasMeaningfulLocalState(state: EmailFinanceSyncState): boolean {
	return Boolean(
		state.cursor
		|| state.lastAttemptAt
		|| state.lastSuccessfulSyncAt
		|| state.lastSyncSummary
		|| state.lastSyncStatus !== 'idle',
	);
}

function hasMeaningfulCheckpoint(checkpoint: MailConsumerCheckpoint | null): boolean {
	if (!checkpoint) {
		return false;
	}

	return Boolean(
		checkpoint.cursor
		|| checkpoint.watermark
		|| checkpoint.lastAttemptAt
		|| checkpoint.lastSuccessAt
		|| checkpoint.summary
		|| checkpoint.lastStatus !== undefined,
	);
}

function toCheckpoint(
	key: MailConsumerCheckpointKey,
	state: EmailFinanceSyncState,
): MailConsumerCheckpoint {
	return {
		key,
		cursor: state.cursor,
		watermark: state.lastSuccessfulSyncAt,
		lastAttemptAt: state.lastAttemptAt,
		lastSuccessAt: state.lastSuccessfulSyncAt,
		lastStatus: state.lastSyncStatus,
		summary: state.lastSyncSummary,
	};
}
