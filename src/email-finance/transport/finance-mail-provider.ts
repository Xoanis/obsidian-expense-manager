import { requestUrl } from 'obsidian';
import type { EmailFinanceProviderKind, ExpenseManagerSettings } from '../../settings';
import type { PluginLogger } from '../../utils/plugin-debug-log';
import { ImapFlow, type MessageAddressObject, type MessageStructureObject } from 'imapflow';

export interface FinanceMailAttachment {
	id: string;
	fileName: string;
	mimeType?: string;
	byteLength?: number;
	contentBase64?: string;
}

export interface FinanceMailMessage {
	id: string;
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
}

export interface FinanceMailProvider {
	readonly kind: EmailFinanceProviderKind;
	listMessages(options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch>;
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
}

interface HttpJsonFinanceMailApiResponse {
	messages?: FinanceMailMessage[];
	nextCursor?: string | null;
}

class HttpJsonFinanceMailProvider implements FinanceMailProvider {
	readonly kind: EmailFinanceProviderKind = 'http-json';

	constructor(
		private readonly settings: Pick<ExpenseManagerSettings, 'emailFinanceProviderBaseUrl' | 'emailFinanceProviderAuthToken'>,
		private readonly logger?: PluginLogger,
	) {}

	async listMessages(options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch> {
		const baseUrl = this.settings.emailFinanceProviderBaseUrl.trim().replace(/\/+$/, '');
		if (!baseUrl) {
			throw new Error('Email finance provider base URL is empty.');
		}

		const url = new URL(`${baseUrl}/messages`);
		if (options.cursor) {
			url.searchParams.set('cursor', options.cursor);
		}
		if (options.since) {
			url.searchParams.set('since', options.since);
		}
		if (options.mailboxScope) {
			url.searchParams.set('mailboxScope', options.mailboxScope);
		}

		this.logger?.info('Email finance provider request', {
			providerKind: this.kind,
			url: url.toString(),
		});
		const response = await requestUrl({
			url: url.toString(),
			method: 'GET',
			headers: this.settings.emailFinanceProviderAuthToken.trim()
				? {
					Authorization: `Bearer ${this.settings.emailFinanceProviderAuthToken.trim()}`,
				}
				: undefined,
		});
		const payload = JSON.parse(response.text) as HttpJsonFinanceMailApiResponse;
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		return {
			messages: messages.map((message) => ({
				...message,
				attachmentNames: Array.isArray(message.attachmentNames)
					? message.attachmentNames
					: Array.isArray(message.attachments)
						? message.attachments.map((attachment) => attachment.fileName).filter(Boolean)
						: [],
				attachments: Array.isArray(message.attachments) ? message.attachments : [],
			})),
			nextCursor: typeof payload.nextCursor === 'string' || payload.nextCursor === null
				? payload.nextCursor
				: null,
		};
	}
}

class ImapFinanceMailProvider implements FinanceMailProvider {
	readonly kind: EmailFinanceProviderKind = 'imap';
	private static readonly FETCH_UID_CHUNK_SIZE = 25;
	private static readonly CONNECT_TIMEOUT_MS = 20_000;
	private static readonly MAILBOX_TIMEOUT_MS = 20_000;
	private static readonly SEARCH_TIMEOUT_MS = 30_000;
	private static readonly FETCH_CHUNK_TIMEOUT_MS = 30_000;
	private static readonly FETCH_MESSAGE_TIMEOUT_MS = 20_000;
	private static readonly DOWNLOAD_PART_TIMEOUT_MS = 15_000;

	constructor(
		private readonly settings: Pick<
			ExpenseManagerSettings,
			| 'emailFinanceImapHost'
			| 'emailFinanceImapPort'
			| 'emailFinanceImapSecure'
			| 'emailFinanceImapUser'
			| 'emailFinanceImapPassword'
		>,
		private readonly logger?: PluginLogger,
	) {}

	async listMessages(options: FinanceMailProviderListOptions): Promise<FinanceMailSyncBatch> {
		const host = this.settings.emailFinanceImapHost.trim();
		const user = this.settings.emailFinanceImapUser.trim();
		const pass = this.settings.emailFinanceImapPassword.trim();
		const mailboxScope = options.mailboxScope?.trim() || 'INBOX';
		if (!host || !user || !pass) {
			throw new Error('IMAP host, username, and app password are required.');
		}

		const client = new ImapFlow({
			host,
			port: this.settings.emailFinanceImapPort,
			secure: this.settings.emailFinanceImapSecure,
			auth: {
				user,
				pass,
			},
			disableAutoIdle: true,
			connectionTimeout: ImapFinanceMailProvider.CONNECT_TIMEOUT_MS,
			greetingTimeout: 15_000,
			socketTimeout: 60_000,
			logger: false,
		});

		let lock: { release(): void } | null = null;
		let stage = 'connect';
		try {
			this.logger?.warn('IMAP sync stage started', {
				stage,
				host,
				port: this.settings.emailFinanceImapPort,
				secure: this.settings.emailFinanceImapSecure,
				mailboxScope,
			});
			await this.withTimeout(
				client.connect(),
				ImapFinanceMailProvider.CONNECT_TIMEOUT_MS,
				'connect',
			);
			stage = 'open-mailbox';
			this.logger?.warn('IMAP sync stage started', { stage, mailboxScope });
			lock = await this.withTimeout(
				client.getMailboxLock(mailboxScope, {
					readOnly: true,
				}),
				ImapFinanceMailProvider.MAILBOX_TIMEOUT_MS,
				stage,
			);

			const sinceDate = options.since ? new Date(options.since) : null;
			stage = 'search';
			this.logger?.warn('IMAP sync stage started', {
				stage,
				since: sinceDate?.toISOString() ?? null,
			});
			const searchQuery = sinceDate
				? {
					all: true,
					since: new Date(sinceDate.getFullYear(), sinceDate.getMonth(), sinceDate.getDate()),
				}
				: { all: true };
			const uids = await this.withTimeout(
				client.search(searchQuery, { uid: true }),
				ImapFinanceMailProvider.SEARCH_TIMEOUT_MS,
				stage,
			);
			if (!uids || uids.length === 0) {
				return {
					messages: [],
					nextCursor: null,
				};
			}
			this.logger?.warn('IMAP search completed', {
				totalUidCount: uids.length,
				isInitialSync: !sinceDate,
			});

			const messages: FinanceMailMessage[] = [];
			for (const uidChunk of this.chunkNumbers(uids, ImapFinanceMailProvider.FETCH_UID_CHUNK_SIZE)) {
				stage = 'fetch-metadata';
				try {
					const chunkMessagesDescription = await this.withTimeout(
						this.collectFetchChunk(client, uidChunk),
						ImapFinanceMailProvider.FETCH_CHUNK_TIMEOUT_MS,
						`${stage} [${uidChunk[0]}-${uidChunk[uidChunk.length - 1]}]`,
					);
					this.logger?.warn('IMAP fetch chunk completed', {
						chunkStartUid: uidChunk[0],
						chunkEndUid: uidChunk[uidChunk.length - 1],
						chunkSize: uidChunk.length,
						fetchedMessages: chunkMessagesDescription.length,
					});
					for (const message_description of chunkMessagesDescription) {
						const message = await this.buildMessage(client, message_description, sinceDate);
						if (message) {
							messages.push(message);
						}
					}
				} catch (chunkError) {
					this.logger?.warn('IMAP chunk fetch failed, retrying one-by-one', {
						chunkStartUid: uidChunk[0],
						chunkEndUid: uidChunk[uidChunk.length - 1],
						chunkSize: uidChunk.length,
						error: (chunkError as Error).message,
					});
					for (const uid of uidChunk) {
						stage = 'fetch-single-message';
						try {
							const single = await this.withTimeout(
								client.fetchOne(uid, {
									uid: true,
									envelope: true,
									internalDate: true,
									bodyStructure: true,
								}, { uid: true }),
								ImapFinanceMailProvider.FETCH_MESSAGE_TIMEOUT_MS,
								`${stage} [uid=${uid}]`,
							);
							if (!single) {
								continue;
							}

							const message = await this.buildMessage(client, single, sinceDate);
							if (message) {
								messages.push(message);
							}
						} catch (messageError) {
							this.logger?.warn('IMAP message fetch failed, skipping message', {
								uid,
								error: (messageError as Error).message,
							});
						}
					}
				}
			}

			return {
				messages,
				nextCursor: null,
			};
		} catch (error) {
			const normalizedError = this.createImapOperationError(error, {
				host,
				port: this.settings.emailFinanceImapPort,
				secure: this.settings.emailFinanceImapSecure,
				user,
				mailboxScope,
				stage,
			});
			this.logger?.error('IMAP finance provider failed', normalizedError);
			throw normalizedError;
		} finally {
			try {
				lock?.release();
			} catch {
				// no-op
			}

			try {
				await client.logout();
			} catch {
				// no-op
			}
		}
	}

	private async collectFetchChunk(
		client: ImapFlow,
		uidChunk: number[],
	): Promise<Array<{
		uid: number;
		threadId?: string;
		envelope?: { from?: MessageAddressObject[]; subject?: string };
		internalDate?: Date | string;
		bodyStructure?: MessageStructureObject;
	}>> {
		const messages: Array<{
			uid: number;
			threadId?: string;
			envelope?: { from?: MessageAddressObject[]; subject?: string };
			internalDate?: Date | string;
			bodyStructure?: MessageStructureObject;
		}> = [];

		for await (const message of client.fetch(uidChunk, {
			uid: true,
			envelope: true,
			internalDate: true,
			bodyStructure: true,
		}, { uid: true })) {
			messages.push(message);
		}

		return messages;
	}

	private async buildMessage(
		client: ImapFlow,
		message: {
			uid: number;
			threadId?: string;
			envelope?: { from?: MessageAddressObject[]; subject?: string };
			internalDate?: Date | string;
			bodyStructure?: MessageStructureObject;
		},
		sinceDate: Date | null,
	): Promise<FinanceMailMessage | null> {
		const receivedAt = this.normalizeReceivedAt(message.internalDate);
		if (sinceDate && new Date(receivedAt).getTime() <= sinceDate.getTime()) {
			return null;
		}

		const parts = this.collectMessageParts(message.bodyStructure);
		const downloads = await this.downloadMessageParts(client, message.uid, parts);
		const textBody = parts.textPartIds
			.map((partId) => downloads[partId]?.content?.toString('utf8') ?? '')
			.filter(Boolean)
			.join('\n\n')
			.trim();
		const htmlBody = parts.htmlPartIds
			.map((partId) => downloads[partId]?.content?.toString('utf8') ?? '')
			.filter(Boolean)
			.join('\n\n')
			.trim();
		const attachments = parts.attachmentParts.map((part) => {
			const download = downloads[part.part];
			const content = download?.content ?? null;
			return {
				id: part.part,
				fileName: part.fileName,
				mimeType: part.mimeType,
				byteLength: content?.byteLength,
				contentBase64: content ? content.toString('base64') : undefined,
			};
		}).filter((attachment) => attachment.contentBase64);

		return {
			id: String(message.uid),
			threadId: message.threadId ? String(message.threadId) : undefined,
			from: this.formatFromAddress(message.envelope?.from?.[0]),
			subject: message.envelope?.subject ?? '',
			receivedAt,
			textBody,
			htmlBody,
			textBodyPreview: textBody.slice(0, 2000),
			htmlBodyPreview: htmlBody.slice(0, 2000),
			attachmentNames: attachments.map((attachment) => attachment.fileName),
			attachments,
		};
	}

	private async downloadMessageParts(
		client: ImapFlow,
		uid: number,
		parts: {
			textPartIds: string[];
			htmlPartIds: string[];
			attachmentParts: Array<{ part: string; fileName: string; mimeType?: string }>;
		},
	): Promise<Record<string, { content: Buffer | null }>> {
		const result: Record<string, { content: Buffer | null }> = {};
		const requestedParts = [
			...parts.textPartIds,
			...parts.htmlPartIds,
			...parts.attachmentParts.map((part) => part.part),
		];

		for (const partId of requestedParts) {
			try {
				const download = await this.withTimeout(
					client.download(uid, partId, { uid: true }),
					ImapFinanceMailProvider.DOWNLOAD_PART_TIMEOUT_MS,
					`download part [uid=${uid}, part=${partId}]`,
				);
				const content = await this.withTimeout(
					this.readStreamToBuffer(download.content),
					ImapFinanceMailProvider.DOWNLOAD_PART_TIMEOUT_MS,
					`read part stream [uid=${uid}, part=${partId}]`,
				);
				result[partId] = { content };
			} catch (error) {
				this.logger?.warn('IMAP part download failed, skipping part', {
					uid,
					partId,
					error: (error as Error).message,
				});
			}
		}

		return result;
	}

	private async readStreamToBuffer(stream: NodeJS.ReadableStream | undefined): Promise<Buffer | null> {
		if (!stream) {
			return null;
		}

		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			const chunkValue: unknown = chunk;
			if (Buffer.isBuffer(chunk)) {
				chunks.push(chunk);
				continue;
			}

			if (chunkValue instanceof Uint8Array) {
				chunks.push(Buffer.from(chunkValue));
				continue;
			}

			chunks.push(Buffer.from(String(chunk)));
		}

		return Buffer.concat(chunks);
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_, reject) => {
					timeoutHandle = setTimeout(() => {
						reject(new Error(`Timed out after ${timeoutMs} ms during ${stage}`));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}

	private chunkNumbers(values: number[], chunkSize: number): number[][] {
		if (chunkSize <= 0) {
			return [values];
		}

		const chunks: number[][] = [];
		for (let index = 0; index < values.length; index += chunkSize) {
			chunks.push(values.slice(index, index + chunkSize));
		}
		return chunks;
	}

	private createImapOperationError(
		error: unknown,
		context: {
			host: string;
			port: number;
			secure: boolean;
			user: string;
			mailboxScope: string;
			stage: string;
		},
	): Error {
		const details = this.collectErrorDetails(error);
		const location = `${context.host}:${context.port}`;
		const tlsMode = context.secure ? 'TLS' : 'plain';
		const baseMessage = `IMAP ${context.stage} failed for ${context.user} at ${location} (${tlsMode}, mailbox ${context.mailboxScope})`;
		const hints = this.buildImapHints(details.codes, details.messages);
		const parts = [
			baseMessage,
			...details.messages,
			...hints,
		].filter((value, index, values) => value && values.indexOf(value) === index);
		return new Error(parts.join('. '));
	}

	private collectErrorDetails(error: unknown): { messages: string[]; codes: string[] } {
		const messages: string[] = [];
		const codes: string[] = [];
		const visit = (value: unknown): void => {
			if (!value) {
				return;
			}

			const maybeError = value as {
				message?: unknown;
				code?: unknown;
				errors?: unknown[];
				cause?: unknown;
			};
			if (typeof maybeError.message === 'string' && maybeError.message.trim().length > 0) {
				messages.push(maybeError.message.trim());
			}
			if (typeof maybeError.code === 'string' && maybeError.code.trim().length > 0) {
				codes.push(maybeError.code.trim());
			}
			if (Array.isArray(maybeError.errors)) {
				for (const nested of maybeError.errors) {
					visit(nested);
				}
			}
			if (maybeError.cause && maybeError.cause !== value) {
				visit(maybeError.cause);
			}
		};

		visit(error);
		return {
			messages: messages.length > 0 ? messages : ['Unknown IMAP error'],
			codes,
		};
	}

	private buildImapHints(codes: string[], messages: string[]): string[] {
		const normalizedCodes = codes.map((code) => code.toUpperCase());
		const joinedMessages = messages.join(' ').toLowerCase();
		const hints: string[] = [];

		if (normalizedCodes.includes('ENOTFOUND') || normalizedCodes.includes('EAI_AGAIN')) {
			hints.push('Check the IMAP host name and DNS/network availability');
		}
		if (normalizedCodes.includes('ECONNREFUSED')) {
			hints.push('Check the IMAP port and whether the secure connection setting matches the server');
		}
		if (normalizedCodes.includes('ETIMEDOUT')) {
			hints.push('The IMAP server did not respond in time; verify network access and firewall rules');
		}
		if (normalizedCodes.includes('ECONNRESET')) {
			hints.push('The server closed the connection; this can happen when the TLS mode or port is incorrect');
		}
		if (joinedMessages.includes('certificate') || joinedMessages.includes('ssl') || joinedMessages.includes('tls')) {
			hints.push('This looks like a TLS/certificate problem; verify the secure connection setting and server certificate chain');
		}
		if (
			joinedMessages.includes('auth')
			|| joinedMessages.includes('login')
			|| joinedMessages.includes('invalid credentials')
			|| joinedMessages.includes('authentication')
		) {
			hints.push('Check the username and make sure you are using an application password, not the regular mailbox password');
		}

		return hints;
	}

	private normalizeReceivedAt(value: Date | string | undefined): string {
		if (value instanceof Date) {
			return value.toISOString();
		}

		if (typeof value === 'string') {
			const parsed = new Date(value);
			if (!Number.isNaN(parsed.getTime())) {
				return parsed.toISOString();
			}
		}

		return new Date().toISOString();
	}

	private formatFromAddress(address: MessageAddressObject | undefined): string | undefined {
		if (!address) {
			return undefined;
		}

		if (address.name && address.address) {
			return `${address.name} <${address.address}>`;
		}

		return address.address || address.name || undefined;
	}

	private collectMessageParts(bodyStructure: MessageStructureObject | undefined): {
		textPartIds: string[];
		htmlPartIds: string[];
		attachmentParts: Array<{ part: string; fileName: string; mimeType?: string }>;
	} {
		const result = {
			textPartIds: [] as string[],
			htmlPartIds: [] as string[],
			attachmentParts: [] as Array<{ part: string; fileName: string; mimeType?: string }>,
		};

		const visit = (node: MessageStructureObject | undefined, isRoot = false): void => {
			if (!node) {
				return;
			}

			if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
				for (const child of node.childNodes) {
					visit(child, false);
				}
				return;
			}

			// ImapFlow can expose a single-part message body as the root node without a part id.
			// In that case, download('1') activates the library's built-in single-part TEXT fallback.
			const part = node.part || (isRoot && (node.type || '').toLowerCase().startsWith('text/') ? '1' : '');
			if (!part) {
				return;
			}

			const mimeType = (node.type || '').toLowerCase();
			const disposition = (node.disposition || '').toLowerCase();
			const fileName = node.dispositionParameters?.filename || node.parameters?.name;

			if (fileName || disposition === 'attachment') {
				result.attachmentParts.push({
					part,
					fileName: fileName || `attachment-${part}`,
					mimeType: mimeType || undefined,
				});
				return;
			}

			if (mimeType.startsWith('text/')) {
				if (mimeType === 'text/html') {
					result.htmlPartIds.push(part);
					return;
				}

				if (mimeType === 'text/plain' || disposition !== 'inline') {
					result.textPartIds.push(part);
					return;
				}

				result.textPartIds.push(part);
			}
		};

		visit(bodyStructure, true);
		return result;
	}
}

export function createFinanceMailProvider(
	settings: Pick<
		ExpenseManagerSettings,
		| 'emailFinanceProvider'
		| 'emailFinanceProviderBaseUrl'
		| 'emailFinanceProviderAuthToken'
		| 'emailFinanceImapHost'
		| 'emailFinanceImapPort'
		| 'emailFinanceImapSecure'
		| 'emailFinanceImapUser'
		| 'emailFinanceImapPassword'
	>,
	logger?: PluginLogger,
): FinanceMailProvider {
	if (settings.emailFinanceProvider === 'imap') {
		return new ImapFinanceMailProvider(settings, logger);
	}

	if (settings.emailFinanceProvider === 'http-json') {
		return new HttpJsonFinanceMailProvider(settings, logger);
	}

	if (settings.emailFinanceProvider === 'none') {
		return new NoopFinanceMailProvider(logger);
	}

	return new NoopFinanceMailProvider(logger);
}
