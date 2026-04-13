import type { App } from 'obsidian';
import {
	createDefaultEmailFinanceSyncState,
	type EmailFinanceSyncState,
	type ExpenseManagerSettings,
} from '../../settings';
import { resolveEmailProviderSelection } from '../../integrations/email-provider/client';
import { buildEmailProviderChannelSelectionKey } from '../../integrations/email-provider/channel-selection';
import type {
	MailConsumerCheckpoint,
	MailConsumerCheckpointKey,
} from '../../integrations/email-provider/types';
import type { PluginLogger } from '../../utils/plugin-debug-log';

export const EMAIL_FINANCE_CHECKPOINT_CONSUMER_ID = 'expense-manager:email-finance-sync';
const DEFAULT_SCOPE_FINGERPRINT = 'mailbox:default';

export interface EmailFinanceSyncStateStore {
	getState(): Promise<EmailFinanceSyncState>;
	update(patch: Partial<EmailFinanceSyncState>): Promise<EmailFinanceSyncState>;
	reset(): Promise<EmailFinanceSyncState>;
}

export class LocalEmailFinanceSyncStateStore implements EmailFinanceSyncStateStore {
	constructor(
		private readonly getStateSnapshot: () => EmailFinanceSyncState,
		private readonly persistStateSnapshot: (nextState: EmailFinanceSyncState) => Promise<void>,
	) {}

	async getState(): Promise<EmailFinanceSyncState> {
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
		const nextState = createDefaultEmailFinanceSyncState();
		await this.persistStateSnapshot(nextState);
		return nextState;
	}
}

export class EmailProviderCheckpointSyncStateStore implements EmailFinanceSyncStateStore {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => Pick<
			ExpenseManagerSettings,
			| 'emailFinanceMailboxScope'
			| 'emailFinanceProviderChannelId'
		>,
		private readonly persistLocalMirror: (nextState: EmailFinanceSyncState) => Promise<void>,
		private readonly logger?: PluginLogger,
	) {}

	async getState(): Promise<EmailFinanceSyncState> {
		const { checkpoint } = await this.readCheckpoint();
		const state = checkpoint
			? this.fromCheckpoint(checkpoint)
			: createDefaultEmailFinanceSyncState();
		await this.persistMirror(state);
		return state;
	}

	async update(patch: Partial<EmailFinanceSyncState>): Promise<EmailFinanceSyncState> {
		const { api, key, checkpoint } = await this.readCheckpoint();
		const nextState: EmailFinanceSyncState = {
			...(checkpoint ? this.fromCheckpoint(checkpoint) : createDefaultEmailFinanceSyncState()),
			...patch,
		};
		await api.saveCheckpoint(this.toCheckpoint(key, nextState));
		await this.persistMirror(nextState);
		return nextState;
	}

	async reset(): Promise<EmailFinanceSyncState> {
		const { api, key } = await this.readCheckpoint();
		const nextState = createDefaultEmailFinanceSyncState();
		await api.saveCheckpoint(this.toCheckpoint(key, nextState));
		await this.persistMirror(nextState);
		return nextState;
	}

	private async readCheckpoint(): Promise<{
		api: ReturnType<typeof resolveEmailProviderSelection>['api'];
		key: MailConsumerCheckpointKey;
		checkpoint: MailConsumerCheckpoint | null;
	}> {
		const settings = this.getSettings();
		const runtime = resolveEmailProviderSelection(
			this.app,
			settings.emailFinanceProviderChannelId,
		);
		const key = this.buildCheckpointKey(
			runtime.channels.map((channel) => channel.id),
			settings.emailFinanceMailboxScope,
		);
		const checkpoint = await runtime.api.getCheckpoint(key);
		return {
			api: runtime.api,
			key,
			checkpoint,
		};
	}

	private buildCheckpointKey(
		channelIds: string[],
		mailboxScope: string,
	): MailConsumerCheckpointKey {
		return buildEmailFinanceCheckpointKey(channelIds, mailboxScope);
	}

	private fromCheckpoint(checkpoint: MailConsumerCheckpoint): EmailFinanceSyncState {
		return {
			lastSuccessfulSyncAt: checkpoint.watermark ?? null,
			cursor: checkpoint.cursor ?? null,
			lastAttemptAt: checkpoint.lastAttemptAt ?? null,
			lastSyncStatus: checkpoint.lastStatus ?? 'idle',
			lastSyncSummary: checkpoint.summary ?? null,
		};
	}

	private toCheckpoint(
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

	private async persistMirror(state: EmailFinanceSyncState): Promise<void> {
		try {
			await this.persistLocalMirror(state);
		} catch (error) {
			this.logger?.warn('Email finance sync state mirror persistence failed', {
				error: (error as Error).message,
			});
		}
	}
}

export function buildEmailFinanceCheckpointKey(
	channelId: string | string[],
	mailboxScope: string,
): MailConsumerCheckpointKey {
	const normalizedChannelId = buildEmailProviderChannelSelectionKey(
		Array.isArray(channelId) ? channelId : [channelId],
	);
	return {
		consumerId: EMAIL_FINANCE_CHECKPOINT_CONSUMER_ID,
		channelId: normalizedChannelId,
		scopeFingerprint: buildEmailFinanceScopeFingerprint(mailboxScope),
	};
}

export function buildEmailFinanceScopeFingerprint(mailboxScope: string): string {
	const normalizedScope = mailboxScope.trim();
	if (!normalizedScope) {
		return DEFAULT_SCOPE_FINGERPRINT;
	}

	return `mailbox:${normalizedScope}`;
}
