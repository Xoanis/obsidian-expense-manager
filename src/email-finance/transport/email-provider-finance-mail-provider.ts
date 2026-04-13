import type { App } from 'obsidian';
import type { ExpenseManagerSettings } from '../../settings';
import {
	getEmailProviderApi,
	resolveEmailProviderSelection,
} from '../../integrations/email-provider/client';
import type {
	IEmailProviderApi,
	MailMessageDetails,
	MailMessageRef,
} from '../../integrations/email-provider/types';
import type { PluginLogger } from '../../utils/plugin-debug-log';
import type {
	FinanceMailAttachment,
	FinanceMailMessage,
	FinanceMailProvider,
	FinanceMailProviderGetOptions,
	FinanceMailProviderListOptions,
	FinanceMailSyncBatch,
} from './finance-mail-provider';

const EMAIL_PROVIDER_MESSAGE_ID_PREFIX = 'email-provider:';

export class EmailProviderFinanceMailProvider implements FinanceMailProvider {
	readonly kind = 'email-provider' as const;

	constructor(
		private readonly app: App,
		private readonly settings: Pick<
			ExpenseManagerSettings,
			| 'emailFinanceMailboxScope'
			| 'emailFinanceProviderChannelId'
		>,
		private readonly logger?: PluginLogger,
	) {}

	async listMessages(options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch> {
		const { api, channels } = this.resolveSelection();
		const folderScope = this.resolveFolderScope(options.mailboxScope);
		const result = await api.searchMessages({
			channelIds: channels.map((channel) => channel.id),
			receivedAfter: options.since ?? undefined,
			folderScope,
			cursor: options.cursor ?? undefined,
			limit: options.limit,
		});

		const messages: FinanceMailMessage[] = [];
		for (const summary of result.messages) {
			const details = await api.getMessage({
				...summary.ref,
				scopeId: folderScope ?? summary.ref.scopeId,
			});
			if (!details) {
				continue;
			}

			messages.push(await this.toFinanceMailMessage(api, details, folderScope));
		}

		return {
			messages,
			nextCursor: typeof result.nextCursor === 'string' || result.nextCursor === null
				? result.nextCursor
				: null,
		};
	}

	async getMessage(
		messageId: string,
		options?: FinanceMailProviderGetOptions,
	): Promise<FinanceMailMessage | null> {
		const api = this.requireApi();
		const parsed = this.parseSerializedMessageId(messageId);
		const scopeId = options?.mailboxScope?.trim() || this.resolveFolderScope(undefined);
		if (parsed) {
			const details = await api.getMessage({
				channelId: parsed.channelId,
				externalId: parsed.externalId,
				scopeId,
			});
			if (!details) {
				return null;
			}

			return this.toFinanceMailMessage(api, details, scopeId);
		}

		return this.getRawMessageFromSelection(api, messageId, scopeId);
	}

	private requireApi(): IEmailProviderApi {
		const api = getEmailProviderApi(this.app);
		if (!api) {
			throw new Error(
				'The workspace email-provider plugin is not available. Install and enable "obsidian-email-provider", then try again.',
			);
		}

		return api;
	}

	private resolveSelection(explicitChannelSelection?: string) {
		return resolveEmailProviderSelection(
			this.app,
			explicitChannelSelection?.trim() || this.settings.emailFinanceProviderChannelId,
		);
	}

	private async toFinanceMailMessage(
		api: IEmailProviderApi,
		message: MailMessageDetails,
		folderScope?: string,
	): Promise<FinanceMailMessage> {
		const attachments = await Promise.all(message.attachments.map(async (attachment) => {
			try {
				const materialized = await api.materializeAttachment({
					...message.ref,
					scopeId: folderScope ?? message.ref.scopeId,
				}, attachment.id);
				return this.toFinanceAttachment(attachment, materialized.bytes, materialized.byteLength);
			} catch (error) {
				this.logger?.warn('Email provider attachment materialization failed', {
					channelId: message.ref.channelId,
					externalId: message.ref.externalId,
					attachmentId: attachment.id,
					error: (error as Error).message,
				});
				return this.toFinanceAttachment(attachment, null, attachment.byteLength);
			}
		}));

		const attachmentNames = message.attachmentNames && message.attachmentNames.length > 0
			? message.attachmentNames
			: attachments.map((attachment) => attachment.fileName).filter(Boolean);

		return {
			id: this.serializeMessageId(message.ref.channelId, message.ref.externalId),
			threadId: message.threadId,
			from: message.from,
			subject: message.subject,
			receivedAt: message.receivedAt,
			textBody: message.textBody,
			htmlBody: message.htmlBody,
			textBodyPreview: message.textBody?.slice(0, 2000),
			htmlBodyPreview: message.htmlBody?.slice(0, 2000),
			attachmentNames,
			attachments,
		};
	}

	private toFinanceAttachment(
		attachment: MailMessageDetails['attachments'][number],
		bytes: ArrayBuffer | null,
		byteLength?: number,
	): FinanceMailAttachment {
		return {
			id: attachment.id,
			fileName: attachment.fileName,
			mimeType: attachment.mimeType,
			byteLength: byteLength ?? attachment.byteLength,
			contentBase64: bytes ? this.arrayBufferToBase64(bytes) : undefined,
		};
	}

	private serializeMessageId(channelId: string, externalId: string): string {
		return `${EMAIL_PROVIDER_MESSAGE_ID_PREFIX}${encodeURIComponent(channelId)}:${encodeURIComponent(externalId)}`;
	}

	private parseSerializedMessageId(
		value: string,
	): { channelId: string; externalId: string } | null {
		if (!value.startsWith(EMAIL_PROVIDER_MESSAGE_ID_PREFIX)) {
			return null;
		}

		const serialized = value.slice(EMAIL_PROVIDER_MESSAGE_ID_PREFIX.length);
		const separatorIndex = serialized.indexOf(':');
		if (separatorIndex <= 0 || separatorIndex >= serialized.length - 1) {
			return null;
		}

		return {
			channelId: decodeURIComponent(serialized.slice(0, separatorIndex)),
			externalId: decodeURIComponent(serialized.slice(separatorIndex + 1)),
		};
	}

	private async getRawMessageFromSelection(
		api: IEmailProviderApi,
		messageId: string,
		scopeId?: string,
	): Promise<FinanceMailMessage | null> {
		const { channels } = this.resolveSelection();
		let matchedMessage: MailMessageDetails | null = null;

		for (const channel of channels) {
			const ref: MailMessageRef = {
				channelId: channel.id,
				externalId: messageId,
				scopeId,
			};
			const details = await api.getMessage(ref);
			if (!details) {
				continue;
			}
			if (matchedMessage) {
				throw new Error(
					`Email message id "${messageId}" is ambiguous across the selected email-provider channels. ` +
					'Rebuild the note once with a single selected channel to upgrade it to a stable provider message id.',
				);
			}

			matchedMessage = details;
		}

		if (!matchedMessage) {
			return null;
		}

		return this.toFinanceMailMessage(api, matchedMessage, scopeId);
	}

	private resolveFolderScope(explicitScope?: string): string | undefined {
		const resolved = explicitScope?.trim() || this.settings.emailFinanceMailboxScope.trim();
		return resolved || undefined;
	}

	private arrayBufferToBase64(value: ArrayBuffer): string {
		return Buffer.from(value).toString('base64');
	}
}
