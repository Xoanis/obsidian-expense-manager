import type { App } from 'obsidian';
import type { EmailFinanceProviderKind, ExpenseManagerSettings } from '../../settings';
import type { PluginLogger } from '../../utils/plugin-debug-log';

export interface FinanceMailAttachment {
	id: string;
	fileName: string;
	mimeType?: string;
	byteLength?: number;
	contentBase64?: string;
}

export interface FinanceMailMessage {
	id: string;
	mailboxScope?: string;
	threadId?: string;
	from?: string;
	subject?: string;
	receivedAt: string;
	textBody?: string;
	htmlBody?: string;
	textBodyPreview?: string;
	htmlBodyPreview?: string;
	attachmentNames: string[];
	attachments: FinanceMailAttachment[];
}

export interface FinanceMailSyncBatch {
	messages: FinanceMailMessage[];
	nextCursor?: string | null;
}

export interface FinanceMailProviderListOptions {
	cursor?: string | null;
	since?: string | null;
	mailboxScope?: string;
	limit?: number;
}

export interface FinanceMailProviderGetOptions {
	mailboxScope?: string;
}

export interface FinanceMailProvider {
	readonly kind: EmailFinanceProviderKind;
	listMessages(options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch>;
	getMessage(messageId: string, options?: FinanceMailProviderGetOptions): Promise<FinanceMailMessage | null>;
}

class NoopFinanceMailProvider implements FinanceMailProvider {
	readonly kind: EmailFinanceProviderKind = 'none';

	constructor(private readonly logger?: PluginLogger) {}

	async listMessages(_options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch> {
		this.logger?.info('Email finance sync skipped: no mail provider configured.');
		return {
			messages: [],
			nextCursor: null,
		};
	}

	async getMessage(_messageId: string, _options?: FinanceMailProviderGetOptions): Promise<FinanceMailMessage | null> {
		return null;
	}
}

export function createFinanceMailProvider(
	app: App | undefined,
	settings: Pick<
		ExpenseManagerSettings,
		| 'emailFinanceProvider'
		| 'emailFinanceProviderChannelId'
	>,
	logger?: PluginLogger,
): FinanceMailProvider {
	if (settings.emailFinanceProvider === 'email-provider') {
		if (!app) {
			throw new Error('Expense Manager requires the Obsidian app instance to use the workspace email-provider plugin.');
		}

		const { EmailProviderFinanceMailProvider } = require('./email-provider-finance-mail-provider') as typeof import('./email-provider-finance-mail-provider');
		return new EmailProviderFinanceMailProvider(app, settings, logger);
	}

	return new NoopFinanceMailProvider(logger);
}
