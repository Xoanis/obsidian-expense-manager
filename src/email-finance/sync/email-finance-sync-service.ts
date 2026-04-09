import { requestUrl } from 'obsidian';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { ExpenseManagerSettings } from '../../settings';
import type { TransactionData } from '../../types';
import { DuplicateTransactionError } from '../../services/expense-service';
import type { PluginLogger } from '../../utils/plugin-debug-log';
import { EmailFinanceCoarseFilter } from './email-finance-coarse-filter';
import { EmailFinanceMessagePlanner, type PlannedEmailFinanceUnit } from '../planning/email-finance-message-planner';
import { EmailFinanceSyncStateStore } from './email-finance-sync-state-store';
import {
	createFinanceMailProvider,
	FinanceMailProvider,
	type FinanceMailAttachment,
	type FinanceMailMessage,
} from '../transport/finance-mail-provider';
import { FinanceIntakeService } from '../../services/finance-intake-service';
import { PendingFinanceProposalService } from '../review/pending-finance-proposal-service';

export interface EmailFinanceSyncSummary {
	status: 'disabled' | 'no-provider' | 'success';
	totalMessages: number;
	passedCoarseFilter: number;
	filteredOut: number;
	plannedUnits: number;
	createdPendingNotes: number;
	createdNeedsAttentionNotes: number;
	failedUnits: number;
	skippedDuplicates: number;
	nextCursor: string | null;
	summaryText: string;
}

interface ExtractedEmailFinanceProposal {
	unit: PlannedEmailFinanceUnit;
	proposal: TransactionData;
}

interface MergedEmailFinanceProposal {
	proposal: TransactionData;
	unitLabels: string[];
}

interface ConflictingEmailFinanceProposalGroup {
	proposals: MergedEmailFinanceProposal[];
	unitLabels: string[];
}

interface ResolvedEmailFinanceProposals {
	accepted: MergedEmailFinanceProposal[];
	conflicts: ConflictingEmailFinanceProposalGroup[];
}

interface ProcessedMessageOutcome {
	plannedUnits: number;
	createdPendingNotes: number;
	createdNeedsAttentionNotes: number;
	failedUnits: number;
	skippedDuplicates: number;
}

interface RemoteArtifactFetchResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

interface RemoteReceiptMaterializationResult {
	unit: PlannedEmailFinanceUnit | null;
	failureReason?: string;
}

interface EmailFinanceSyncServiceOptions {
	logger?: PluginLogger;
	provider?: FinanceMailProvider;
	coarseFilter?: EmailFinanceCoarseFilter;
	planner?: EmailFinanceMessagePlanner;
}

export class EmailFinanceSyncService {
	private readonly provider?: FinanceMailProvider;
	private readonly coarseFilter: EmailFinanceCoarseFilter;
	private readonly planner: EmailFinanceMessagePlanner;
	private readonly logger?: PluginLogger;

	constructor(
		private readonly getSettings: () => ExpenseManagerSettings,
		private readonly syncStateStore: EmailFinanceSyncStateStore,
		private readonly financeIntakeService: FinanceIntakeService,
		private readonly pendingProposalService: PendingFinanceProposalService,
		options?: EmailFinanceSyncServiceOptions,
	) {
		this.provider = options?.provider;
		this.coarseFilter = options?.coarseFilter ?? new EmailFinanceCoarseFilter();
		this.logger = options?.logger;
		this.planner = options?.planner ?? new EmailFinanceMessagePlanner(undefined, this.logger);
	}

	async syncNewMessages(): Promise<EmailFinanceSyncSummary> {
		const settings = this.getSettings();
		if (!settings.enableEmailFinanceIntake) {
			return {
				status: 'disabled',
				totalMessages: 0,
				passedCoarseFilter: 0,
				filteredOut: 0,
				plannedUnits: 0,
				createdPendingNotes: 0,
				createdNeedsAttentionNotes: 0,
				failedUnits: 0,
				skippedDuplicates: 0,
				nextCursor: this.syncStateStore.getState().cursor,
				summaryText: 'Email finance intake is disabled in settings.',
			};
		}

		const provider = this.provider ?? createFinanceMailProvider(settings, this.logger);
		if (provider.kind === 'none') {
			const state = await this.syncStateStore.update({
				lastAttemptAt: new Date().toISOString(),
				lastSyncStatus: 'skipped',
				lastSyncSummary: 'No mail provider is configured yet.',
			});
			return {
				status: 'no-provider',
				totalMessages: 0,
				passedCoarseFilter: 0,
				filteredOut: 0,
				plannedUnits: 0,
				createdPendingNotes: 0,
				createdNeedsAttentionNotes: 0,
				failedUnits: 0,
				skippedDuplicates: 0,
				nextCursor: state.cursor,
				summaryText: 'No mail provider is configured yet. Configure a provider-compatible endpoint first.',
			};
		}

		const previousState = this.syncStateStore.getState();
		const now = new Date().toISOString();
		await this.syncStateStore.update({
			lastAttemptAt: now,
		});

		const batch = await provider.listMessages({
			cursor: previousState.cursor,
			since: previousState.lastSuccessfulSyncAt,
			mailboxScope: settings.emailFinanceMailboxScope,
		});

		let passedCoarseFilter = 0;
		let filteredOut = 0;
		let plannedUnits = 0;
		let createdPendingNotes = 0;
		let createdNeedsAttentionNotes = 0;
		let failedUnits = 0;
		let skippedDuplicates = 0;
		for (const message of batch.messages) {
			const filterResult = this.coarseFilter.evaluate(message, settings.emailFinanceCoarseFilterRules);
			if (filterResult.passed) {
				passedCoarseFilter += 1;
				const outcome = await this.processMessage(message);
				plannedUnits += outcome.plannedUnits;
				createdPendingNotes += outcome.createdPendingNotes;
				createdNeedsAttentionNotes += outcome.createdNeedsAttentionNotes;
				failedUnits += outcome.failedUnits;
				skippedDuplicates += outcome.skippedDuplicates;
			} else {
				filteredOut += 1;
			}
		}

		const summaryText = `Scanned ${batch.messages.length} email(s): ${passedCoarseFilter} passed coarse filter, ${filteredOut} filtered out, ${plannedUnits} unit(s) planned, ${createdPendingNotes} pending note(s) created, ${createdNeedsAttentionNotes} needs-attention note(s) created, ${skippedDuplicates} duplicate note(s) skipped, ${failedUnits} unit(s) failed.`;
		const nextState = await this.syncStateStore.update({
			lastAttemptAt: now,
			lastSuccessfulSyncAt: now,
			cursor: batch.nextCursor ?? previousState.cursor,
			lastSyncStatus: 'success',
			lastSyncSummary: summaryText,
		});
		this.logger?.info('Email finance sync completed', {
			totalMessages: batch.messages.length,
			passedCoarseFilter,
			filteredOut,
			plannedUnits,
			createdPendingNotes,
			createdNeedsAttentionNotes,
			failedUnits,
			skippedDuplicates,
			nextCursor: nextState.cursor,
		});

		return {
			status: 'success',
			totalMessages: batch.messages.length,
			passedCoarseFilter,
			filteredOut,
			plannedUnits,
			createdPendingNotes,
			createdNeedsAttentionNotes,
			failedUnits,
			skippedDuplicates,
			nextCursor: nextState.cursor,
			summaryText,
		};
	}

	private async processMessage(message: FinanceMailMessage): Promise<ProcessedMessageOutcome> {
		const planningResult = this.planner.planMessageDetailed(message);
		const units = planningResult.units;
		const remoteReceiptCache = new Map<string, Promise<RemoteReceiptMaterializationResult>>();
		this.logger?.info('Email finance message planned', {
			messageId: message.id,
			subject: message.subject,
			parserAttempts: planningResult.parserAttempts.map((attempt) => ({
				parserId: attempt.parserId,
				matched: attempt.matched,
				stop: attempt.stop,
				reason: attempt.reason,
				unitLabels: attempt.units.map((unit) => `${unit.kind}:${unit.label}`),
				diagnostics: attempt.diagnostics ?? null,
			})),
			usedGenericFallback: planningResult.usedGenericFallback,
			attachmentUnitCount: planningResult.attachmentUnitCount,
			textUnitCreated: planningResult.textUnitCreated,
			plannedUnits: units.map((unit) => ({
				kind: unit.kind,
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
			})),
		});
		const extractedProposals: ExtractedEmailFinanceProposal[] = [];
		const failureMessages: string[] = [];
		let failedUnits = 0;

		for (const unit of units) {
			try {
				this.logPlannedUnit(message, unit);
				const materialization = await this.materializeRemoteReceiptUnit(message, unit, remoteReceiptCache);
				if (materialization.failureReason) {
					failureMessages.push(`${this.formatUnitLabel(unit)} -> ${materialization.failureReason}`);
				}
				const effectiveUnit = materialization.unit ?? unit;
				if (effectiveUnit !== unit) {
					this.logPlannedUnit(message, effectiveUnit);
				}
				const proposal = await this.extractProposal(effectiveUnit);
				if (!proposal || proposal.amount <= 0) {
					failedUnits += 1;
					failureMessages.push(`${this.formatUnitLabel(unit)} -> no valid transaction proposal`);
					continue;
				}

				extractedProposals.push({
					unit: effectiveUnit,
					proposal: {
						...proposal,
						source: 'email',
					},
				});
			} catch (error) {
				failedUnits += 1;
				const errorMessage = (error as Error).message;
				failureMessages.push(`${this.formatUnitLabel(unit)} -> ${errorMessage}`);
				this.logger?.warn('Email finance sync unit failed', {
					messageId: message.id,
					label: unit.label,
					error: errorMessage,
				});
			}
		}

		const mergedProposals = this.mergeEquivalentProposals(extractedProposals);
		const resolvedProposals = this.resolveMergedProposals(mergedProposals);
		let createdPendingNotes = 0;
		let createdNeedsAttentionNotes = 0;
		let skippedDuplicates = 0;
		for (const conflict of resolvedProposals.conflicts) {
			try {
				this.logger?.warn('Email finance message has conflicting proposals', {
					messageId: message.id,
					subject: message.subject,
					candidateCount: conflict.proposals.length,
					candidates: conflict.proposals.map((candidate) => this.summarizeProposal(candidate.proposal)),
				});
				const sourceContext = this.buildSourceContext(message, units, failureMessages, {
					kind: 'needs-attention',
					unitLabels: conflict.unitLabels,
					candidateProposals: conflict.proposals,
				});
				await this.pendingProposalService.createNeedsAttentionProposal({
					message,
					reason: this.buildConflictingProposalsReason(conflict),
					sourceContext,
					...this.getBestMessageArtifactFields(message, sourceContext),
				});
				createdNeedsAttentionNotes += 1;
			} catch (error) {
				failedUnits += 1;
				this.logger?.warn('Email finance conflicting proposals note failed', {
					messageId: message.id,
					error: (error as Error).message,
				});
			}
		}

		for (const mergedProposal of resolvedProposals.accepted) {
			try {
				const sourceContext = this.buildSourceContext(message, units, failureMessages, {
					kind: 'pending-approval',
					unitLabels: mergedProposal.unitLabels,
				});
				await this.pendingProposalService.createPendingProposal(this.attachBestMessageArtifact(
					{
						...mergedProposal.proposal,
						source: 'email',
						sourceContext,
					},
					message,
				));
				createdPendingNotes += 1;
			} catch (error) {
				if (error instanceof DuplicateTransactionError) {
					skippedDuplicates += 1;
					this.logger?.info('Email finance sync skipped duplicate proposal', {
						messageId: message.id,
						unitLabels: mergedProposal.unitLabels,
					});
					continue;
				}

				failedUnits += 1;
				const errorMessage = (error as Error).message;
				failureMessages.push(`pending:${mergedProposal.unitLabels.join(', ')} -> ${errorMessage}`);
				this.logger?.warn('Email finance pending proposal persistence failed', {
					messageId: message.id,
					unitLabels: mergedProposal.unitLabels,
					error: errorMessage,
				});
			}
		}

		if (resolvedProposals.accepted.length === 0 && resolvedProposals.conflicts.length === 0) {
			try {
				const sourceContext = this.buildSourceContext(message, units, failureMessages, {
					kind: 'needs-attention',
					unitLabels: [],
				});
				await this.pendingProposalService.createNeedsAttentionProposal({
					message,
					reason: this.buildNeedsAttentionReason(units, failureMessages),
					sourceContext,
					...this.getBestMessageArtifactFields(message, sourceContext),
				});
				createdNeedsAttentionNotes += 1;
			} catch (error) {
				failedUnits += 1;
				this.logger?.warn('Email finance needs-attention note failed', {
					messageId: message.id,
					error: (error as Error).message,
				});
			}
		}

		return {
			plannedUnits: units.length,
			createdPendingNotes,
			createdNeedsAttentionNotes,
			failedUnits,
			skippedDuplicates,
		};
	}

	private async materializeRemoteReceiptUnit(
		message: FinanceMailMessage,
		unit: PlannedEmailFinanceUnit,
		cache: Map<string, Promise<RemoteReceiptMaterializationResult>>,
	): Promise<RemoteReceiptMaterializationResult> {
		if (unit.kind !== 'text' || !unit.remoteArtifactUrl) {
			return { unit: null };
		}

		const cacheKey = `${unit.remoteArtifactUrl}::${unit.remoteArtifactFileName ?? ''}`;
		if (!cache.has(cacheKey)) {
			cache.set(cacheKey, this.fetchRemoteReceiptUnit(message, unit));
		}
		return await (cache.get(cacheKey) ?? Promise.resolve({ unit: null }));
	}

	private async fetchRemoteReceiptUnit(
		message: FinanceMailMessage,
		unit: Extract<PlannedEmailFinanceUnit, { kind: 'text' }>,
	): Promise<RemoteReceiptMaterializationResult> {
		const url = unit.remoteArtifactUrl;
		if (!url) {
			return { unit: null };
		}

		this.logger?.info('Email finance remote artifact fetch started', {
			messageId: message.id,
			label: unit.label,
			plannerSourceId: unit.plannerSourceId ?? 'unknown',
			url,
		});

		try {
			const response = await this.fetchRemoteArtifact(url);
			const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
			const looksLikePdf = this.looksLikePdfResponse(response.arrayBuffer, contentType, url);
			if (response.status >= 400 || !looksLikePdf) {
				this.logger?.warn('Email finance remote artifact fetch fell back to text route', {
					messageId: message.id,
					label: unit.label,
					plannerSourceId: unit.plannerSourceId ?? 'unknown',
					url,
					status: response.status,
					contentType,
					textPreview: response.text.slice(0, 400),
				});
				return {
					unit: null,
					failureReason: `remote artifact fetch fell back to text route (status=${response.status}, contentType=${contentType || 'unknown'})`,
				};
			}

			const fileName = this.resolveRemoteArtifactFileName(
				response.headers['content-disposition'] ?? response.headers['Content-Disposition'] ?? '',
				unit.remoteArtifactFileName,
				url,
			);
			const mimeType = unit.remoteArtifactMimeType ?? (contentType.split(';')[0]?.trim() || 'application/pdf');
			this.logger?.info('Email finance remote artifact fetched', {
				messageId: message.id,
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				url,
				status: response.status,
				contentType,
				fileName,
				byteLength: response.arrayBuffer.byteLength,
			});

			return {
				unit: {
					kind: 'receipt',
					label: `${unit.label} [remote-artifact]`,
					plannerSourceId: `${unit.plannerSourceId ?? 'unknown'}:remote-artifact`,
					request: {
						bytes: response.arrayBuffer,
						fileName,
						mimeType,
						caption: unit.request.text,
						intent: 'neutral',
						source: 'email',
					},
				},
			};
		} catch (error) {
			const errorMessage = (error as Error).message;
			this.logger?.warn('Email finance remote artifact fetch failed', {
				messageId: message.id,
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				url,
				error: errorMessage,
			});
			return {
				unit: null,
				failureReason: `remote artifact fetch failed (${errorMessage})`,
			};
		}
	}

	private async fetchRemoteArtifact(url: string): Promise<RemoteArtifactFetchResponse> {
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				throw: false,
				headers: this.buildRemoteArtifactRequestHeaders(),
			});
			return {
				status: response.status,
				headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), String(value)])),
				arrayBuffer: response.arrayBuffer,
				text: response.text,
			};
		} catch (error) {
			if (!this.isBlockedByClientError(error)) {
				throw error;
			}

			this.logger?.info('Email finance remote artifact requestUrl blocked, retrying with node http', {
				url,
				error: (error as Error).message,
			});
			return this.fetchRemoteArtifactWithNodeHttp(url);
		}
	}

	private async fetchRemoteArtifactWithNodeHttp(
		url: string,
		redirectCount = 0,
		cookieJar: Map<string, string> = new Map(),
	): Promise<RemoteArtifactFetchResponse> {
		if (redirectCount > 5) {
			throw new Error(`Too many redirects while fetching remote artifact: ${url}`);
		}

		const parsedUrl = new URL(url);
		const requester = parsedUrl.protocol === 'http:' ? httpRequest : httpsRequest;

		return new Promise<RemoteArtifactFetchResponse>((resolve, reject) => {
			const request = requester({
				protocol: parsedUrl.protocol,
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || undefined,
				path: `${parsedUrl.pathname}${parsedUrl.search}`,
				method: 'GET',
				headers: this.buildRemoteArtifactRequestHeaders(cookieJar),
			}, (response) => {
				const status = response.statusCode ?? 0;
				const headers = this.normalizeNodeHeaders(response.headers);
				this.updateCookieJar(cookieJar, headers['set-cookie'] ?? '');
				const redirectLocation = headers.location;
				if (status >= 300 && status < 400 && redirectLocation) {
					this.logger?.debug('Email finance remote artifact redirect', {
						from: url,
						to: new URL(redirectLocation, url).toString(),
						status,
						cookieCount: cookieJar.size,
					});
					response.resume();
					resolve(this.fetchRemoteArtifactWithNodeHttp(
						new URL(redirectLocation, url).toString(),
						redirectCount + 1,
						cookieJar,
					));
					return;
				}

				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer | Uint8Array | string) => {
					if (Buffer.isBuffer(chunk)) {
						chunks.push(chunk);
						return;
					}

					if (chunk instanceof Uint8Array) {
						chunks.push(Buffer.from(chunk));
						return;
					}

					chunks.push(Buffer.from(String(chunk)));
				});
				response.on('end', () => {
					try {
						const rawBuffer = Buffer.concat(chunks);
						const decodedBuffer = this.decodeNodeHttpBuffer(rawBuffer, headers['content-encoding'] ?? '');
						resolve({
							status,
							headers,
							arrayBuffer: decodedBuffer.buffer.slice(
								decodedBuffer.byteOffset,
								decodedBuffer.byteOffset + decodedBuffer.byteLength,
							),
							text: decodedBuffer.toString('utf8'),
						});
					} catch (error) {
						reject(error);
					}
				});
				response.on('error', reject);
			});

			request.setTimeout(20_000, () => {
				request.destroy(new Error(`Timed out while fetching remote artifact: ${url}`));
			});
			request.on('error', reject);
			request.end();
		});
	}

	private async extractProposal(unit: PlannedEmailFinanceUnit): Promise<TransactionData | null> {
		if (unit.kind === 'text') {
			const routingDecision = this.financeIntakeService.routeTextRequest(unit.request);
			this.logger?.info('Email finance text unit route selected', {
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				route: routingDecision.route,
				providerKind: routingDecision.providerKind,
				reason: routingDecision.reason,
			});
			const proposal = await this.financeIntakeService.createTextProposal(unit.request);
			this.logger?.info('Text proposal created from email sync', {
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				proposal: this.summarizeProposal(proposal),
			});
			return proposal;
		}

		const routingDecision = this.financeIntakeService.routeReceiptRequest(unit.request);
		this.logger?.info('Email finance receipt unit route selected', {
			label: unit.label,
			plannerSourceId: unit.plannerSourceId ?? 'unknown',
			route: routingDecision.route,
			providerKind: routingDecision.providerKind,
			reason: routingDecision.reason,
			fileName: unit.request.fileName,
			mimeType: unit.request.mimeType,
			byteLength: unit.request.bytes.byteLength,
		});
		const proposal = await this.financeIntakeService.createReceiptProposal(unit.request);
		this.logger?.info('Receipt proposal created from email sync', {
			label: unit.label,
			plannerSourceId: unit.plannerSourceId ?? 'unknown',
			proposal: this.summarizeProposal(proposal.data ?? null),
		});
		return proposal.data ?? null;
	}

	private looksLikePdfResponse(bytes: ArrayBuffer, contentType: string, url: string): boolean {
		const normalizedType = contentType.toLowerCase();
		if (normalizedType.includes('application/pdf')) {
			return true;
		}
		if (/\.pdf(?:$|[?#])/i.test(url)) {
			return true;
		}

		const signature = this.peekAscii(bytes, 5);
		return signature === '%PDF-';
	}

	private resolveRemoteArtifactFileName(contentDisposition: string, fallback: string | undefined, url: string): string {
		const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
		if (utf8Match) {
			try {
				return decodeURIComponent(utf8Match.trim().replace(/^["']|["']$/g, ''));
			} catch {
				// ignore
			}
		}

		const simpleMatch = contentDisposition.match(/filename\s*=\s*("?)([^";]+)\1/i)?.[2];
		if (simpleMatch) {
			return simpleMatch.trim();
		}

		if (fallback?.trim()) {
			return fallback.trim();
		}

		try {
			const parsedUrl = new URL(url);
			const lastSegment = parsedUrl.pathname.split('/').filter(Boolean).pop();
			if (lastSegment) {
				return lastSegment.toLowerCase().endsWith('.pdf') ? lastSegment : `${lastSegment}.pdf`;
			}
		} catch {
			// ignore
		}

		return 'remote-email-artifact.pdf';
	}

	private peekAscii(bytes: ArrayBuffer, length: number): string {
		const view = new Uint8Array(bytes, 0, Math.min(length, bytes.byteLength));
		return Array.from(view, (value) => String.fromCharCode(value)).join('');
	}

	private buildRemoteArtifactRequestHeaders(cookieJar?: Map<string, string>): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
			Referer: 'https://www.ozon.ru/my/e-check/',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Obsidian Expense Manager',
			'Accept-Encoding': 'identity',
		};
		const cookieHeader = this.buildCookieHeader(cookieJar);
		if (cookieHeader) {
			headers.Cookie = cookieHeader;
		}
		return headers;
	}

	private isBlockedByClientError(error: unknown): boolean {
		return /ERR_BLOCKED_BY_CLIENT/i.test((error as Error)?.message ?? '');
	}

	private normalizeNodeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
		return Object.fromEntries(
			Object.entries(headers)
				.filter((entry): entry is [string, string | string[]] => entry[1] != null)
				.map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]),
		);
	}

	private updateCookieJar(cookieJar: Map<string, string>, setCookieHeader: string): void {
		if (!setCookieHeader) {
			return;
		}

		for (const cookieChunk of setCookieHeader.split(/,(?=[^;,]+=)/)) {
			const firstPart = cookieChunk.split(';', 1)[0]?.trim();
			if (!firstPart) {
				continue;
			}

			const separatorIndex = firstPart.indexOf('=');
			if (separatorIndex <= 0) {
				continue;
			}

			const name = firstPart.slice(0, separatorIndex).trim();
			const value = firstPart.slice(separatorIndex + 1).trim();
			if (!name) {
				continue;
			}

			cookieJar.set(name, value);
		}
	}

	private buildCookieHeader(cookieJar?: Map<string, string>): string {
		if (!cookieJar || cookieJar.size === 0) {
			return '';
		}

		return Array.from(cookieJar.entries())
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}

	private decodeNodeHttpBuffer(buffer: Buffer, contentEncoding: string): Buffer {
		const normalizedEncoding = contentEncoding.toLowerCase();
		try {
			if (normalizedEncoding.includes('br')) {
				return brotliDecompressSync(buffer);
			}
			if (normalizedEncoding.includes('gzip')) {
				return gunzipSync(buffer);
			}
			if (normalizedEncoding.includes('deflate')) {
				return inflateSync(buffer);
			}
		} catch {
			return buffer;
		}
		return buffer;
	}

	private logPlannedUnit(message: FinanceMailMessage, unit: PlannedEmailFinanceUnit): void {
		if (unit.kind === 'text') {
			this.logger?.info('Email finance text unit prepared', {
				messageId: message.id,
				subject: message.subject,
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				remoteArtifactUrl: unit.remoteArtifactUrl ?? null,
				textLength: unit.request.text.length,
				textPreview: unit.request.text.slice(0, 4000),
			});
			this.logger?.debug('Email finance text unit payload', {
				messageId: message.id,
				label: unit.label,
				plannerSourceId: unit.plannerSourceId ?? 'unknown',
				remoteArtifactUrl: unit.remoteArtifactUrl ?? null,
				text: unit.request.text,
			});
			return;
		}

		this.logger?.info('Email finance receipt unit prepared', {
			messageId: message.id,
			subject: message.subject,
			label: unit.label,
			plannerSourceId: unit.plannerSourceId ?? 'unknown',
			fileName: unit.request.fileName,
			mimeType: unit.request.mimeType,
			byteLength: unit.request.bytes.byteLength,
			captionPreview: (unit.request.caption ?? '').slice(0, 1000),
		});
		this.logger?.debug('Email finance receipt unit payload', {
			messageId: message.id,
			label: unit.label,
			plannerSourceId: unit.plannerSourceId ?? 'unknown',
			fileName: unit.request.fileName,
			mimeType: unit.request.mimeType,
			byteLength: unit.request.bytes.byteLength,
			caption: unit.request.caption ?? '',
		});
	}

	private summarizeProposal(proposal: TransactionData | null): Record<string, unknown> | null {
		if (!proposal) {
			return null;
		}

		return {
			type: proposal.type,
			amount: proposal.amount,
			currency: proposal.currency,
			dateTime: proposal.dateTime,
			description: proposal.description,
			category: proposal.category,
			project: proposal.project ?? null,
			area: proposal.area ?? null,
			source: proposal.source ?? null,
			hasArtifact: Boolean(proposal.artifact || proposal.artifactBytes),
			artifactFileName: proposal.artifactFileName ?? null,
			artifactMimeType: proposal.artifactMimeType ?? null,
		};
	}

	private mergeEquivalentProposals(extractedProposals: ExtractedEmailFinanceProposal[]): MergedEmailFinanceProposal[] {
		const merged: MergedEmailFinanceProposal[] = [];
		for (const extracted of extractedProposals) {
			const existing = merged.find((candidate) => this.areEquivalentProposals(candidate.proposal, extracted.proposal));
			if (!existing) {
				merged.push({
					proposal: {
						...extracted.proposal,
						tags: this.uniqueStrings(extracted.proposal.tags ?? []),
					},
					unitLabels: [this.formatUnitLabel(extracted.unit)],
				});
				continue;
			}

			existing.proposal = this.mergeProposalData(existing.proposal, extracted.proposal);
			existing.unitLabels = this.uniqueStrings([
				...existing.unitLabels,
				this.formatUnitLabel(extracted.unit),
			]);
		}

		return merged;
	}

	private resolveMergedProposals(mergedProposals: MergedEmailFinanceProposal[]): ResolvedEmailFinanceProposals {
		const groups: MergedEmailFinanceProposal[][] = [];
		for (const proposal of mergedProposals) {
			const matchingGroupIndexes: number[] = [];
			for (let index = 0; index < groups.length; index += 1) {
				if (groups[index]?.some((candidate) => this.areCompetingProposals(candidate.proposal, proposal.proposal))) {
					matchingGroupIndexes.push(index);
				}
			}

			if (matchingGroupIndexes.length === 0) {
				groups.push([proposal]);
				continue;
			}

			const mergedGroup: MergedEmailFinanceProposal[] = [proposal];
			for (let index = matchingGroupIndexes.length - 1; index >= 0; index -= 1) {
				const groupIndex = matchingGroupIndexes[index];
				const existingGroup = groups[groupIndex];
				if (!existingGroup) {
					continue;
				}
				mergedGroup.push(...existingGroup);
				groups.splice(groupIndex, 1);
			}
			groups.push(mergedGroup);
		}

		const accepted: MergedEmailFinanceProposal[] = [];
		const conflicts: ConflictingEmailFinanceProposalGroup[] = [];
		for (const group of groups) {
			if (group.length <= 1) {
				if (group[0]) {
					accepted.push(group[0]);
				}
				continue;
			}

			const sortedGroup = group.slice().sort((left, right) => this.scoreProposal(right.proposal) - this.scoreProposal(left.proposal));
			const autoResolved = this.tryResolveDominantConflict(sortedGroup);
			if (autoResolved) {
				accepted.push(autoResolved);
				continue;
			}

			conflicts.push({
				proposals: sortedGroup,
				unitLabels: this.uniqueStrings(group.flatMap((proposal) => proposal.unitLabels)),
			});
		}

		return {
			accepted,
			conflicts,
		};
	}

	private tryResolveDominantConflict(group: MergedEmailFinanceProposal[]): MergedEmailFinanceProposal | null {
		const [best, second] = group;
		if (!best || !second) {
			return best ?? null;
		}

		const bestScore = this.scoreProposal(best.proposal);
		const secondScore = this.scoreProposal(second.proposal);
		const bestHasFiscalFields = this.hasFiscalFields(best.proposal);
		const secondHasFiscalFields = this.hasFiscalFields(second.proposal);

		if (!bestHasFiscalFields || secondHasFiscalFields) {
			return null;
		}

		if (bestScore < secondScore + 4) {
			return null;
		}

		if (group.some((candidate) => this.hasFiscalFields(candidate.proposal) && candidate !== best)) {
			return null;
		}

		this.logger?.info('Email finance conflict auto-resolved in favor of dominant fiscal proposal', {
			accepted: this.summarizeProposal(best.proposal),
			rejected: group.slice(1).map((candidate) => this.summarizeProposal(candidate.proposal)),
		});
		return best;
	}

	private areEquivalentProposals(left: TransactionData, right: TransactionData): boolean {
		if (left.type !== right.type) {
			return false;
		}

		if ((left.currency || '').trim().toUpperCase() !== (right.currency || '').trim().toUpperCase()) {
			return false;
		}

		if (Math.abs(left.amount - right.amount) > 0.01) {
			return false;
		}

		const leftTime = new Date(left.dateTime).getTime();
		const rightTime = new Date(right.dateTime).getTime();
		if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
			return left.dateTime === right.dateTime;
		}

		return Math.abs(leftTime - rightTime) <= 15 * 60 * 1000;
	}

	private areCompetingProposals(left: TransactionData, right: TransactionData): boolean {
		if (this.areEquivalentProposals(left, right)) {
			return false;
		}

		if (left.type !== right.type) {
			return false;
		}

		if ((left.currency || '').trim().toUpperCase() !== (right.currency || '').trim().toUpperCase()) {
			return false;
		}

		if (this.shareFiscalIdentity(left, right)) {
			return true;
		}

		const leftTime = new Date(left.dateTime).getTime();
		const rightTime = new Date(right.dateTime).getTime();
		if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
			return Math.abs(leftTime - rightTime) <= 15 * 60 * 1000;
		}

		return Boolean(left.dateTime && right.dateTime && left.dateTime === right.dateTime);
	}

	private shareFiscalIdentity(left: TransactionData, right: TransactionData): boolean {
		return Boolean(
			(left.fn && right.fn && left.fn === right.fn)
			|| (left.fd && right.fd && left.fd === right.fd)
			|| (left.fp && right.fp && left.fp === right.fp),
		);
	}

	private hasFiscalFields(proposal: TransactionData): boolean {
		return Boolean(proposal.fn || proposal.fd || proposal.fp);
	}

	private mergeProposalData(left: TransactionData, right: TransactionData): TransactionData {
		const preferred = this.pickPreferredProposal(left, right);
		const other = preferred === left ? right : left;
		return {
			...other,
			...preferred,
			description: this.pickLongerText(left.description, right.description) || preferred.description,
			category: this.pickPreferredCategory(left.category, right.category) ?? preferred.category,
			project: left.project ?? right.project ?? preferred.project,
			area: left.area ?? right.area ?? preferred.area,
			artifact: left.artifact ?? right.artifact ?? preferred.artifact,
			artifactBytes: left.artifactBytes ?? right.artifactBytes ?? preferred.artifactBytes,
			artifactFileName: left.artifactFileName ?? right.artifactFileName ?? preferred.artifactFileName,
			artifactMimeType: left.artifactMimeType ?? right.artifactMimeType ?? preferred.artifactMimeType,
			details: left.details?.length ? left.details : right.details ?? preferred.details,
			fn: left.fn ?? right.fn ?? preferred.fn,
			fd: left.fd ?? right.fd ?? preferred.fd,
			fp: left.fp ?? right.fp ?? preferred.fp,
			tags: this.uniqueStrings([
				...(left.tags ?? []),
				...(right.tags ?? []),
				'finance',
				'email',
			]),
			source: 'email',
		};
	}

	private attachBestMessageArtifact(proposal: TransactionData, message: FinanceMailMessage): TransactionData {
		if (proposal.artifact || proposal.artifactBytes) {
			return proposal;
		}

		const artifactFields = this.getBestMessageArtifactFields(message, proposal.sourceContext);
		if (!artifactFields.artifactBytes || !artifactFields.artifactFileName) {
			return proposal;
		}

		return {
			...proposal,
			...artifactFields,
		};
	}

	private pickPreferredProposal(left: TransactionData, right: TransactionData): TransactionData {
		const leftScore = this.scoreProposal(left);
		const rightScore = this.scoreProposal(right);
		if (rightScore > leftScore) {
			return right;
		}

		return left;
	}

	private scoreProposal(proposal: TransactionData): number {
		let score = 0;
		if (proposal.fn) score += 3;
		if (proposal.fd) score += 2;
		if (proposal.fp) score += 2;
		if (proposal.artifact || proposal.artifactBytes) score += 2;
		if (proposal.details?.length) score += 2;
		if (proposal.project) score += 1;
		if (proposal.area) score += 1;
		if (this.hasMeaningfulCategory(proposal.category)) score += 1;
		score += Math.min(3, Math.floor((proposal.description?.trim().length ?? 0) / 30));
		return score;
	}

	private hasMeaningfulCategory(value: string | undefined): boolean {
		if (!value) {
			return false;
		}

		const normalized = value.trim().toLowerCase();
		return normalized.length > 0 && normalized !== 'other' && normalized !== 'uncategorized' && normalized !== 'needs attention';
	}

	private pickPreferredCategory(left: string | undefined, right: string | undefined): string | undefined {
		if (this.hasMeaningfulCategory(left)) {
			return left;
		}
		if (this.hasMeaningfulCategory(right)) {
			return right;
		}
		return left ?? right;
	}

	private pickLongerText(left: string | undefined, right: string | undefined): string | undefined {
		const leftValue = left?.trim() ?? '';
		const rightValue = right?.trim() ?? '';
		if (!leftValue) {
			return rightValue || undefined;
		}
		if (!rightValue) {
			return leftValue;
		}
		return rightValue.length > leftValue.length ? rightValue : leftValue;
	}

	private buildNeedsAttentionReason(units: PlannedEmailFinanceUnit[], failureMessages: string[]): string {
		if (units.length === 0) {
			return 'Passed coarse filter, but no extraction units were planned for this email.';
		}

		const authGatedFailure = failureMessages.find((message) =>
			/remote artifact fetch failed|remote artifact fetch fell back|too many redirects|timed out while fetching remote artifact|requires authorization|auth/i.test(message),
		);
		if (authGatedFailure) {
			return 'Passed coarse filter, but the receipt artifact could not be fetched automatically and likely requires authorization or interactive access.';
		}

		if (failureMessages.length === 0) {
			return 'Passed coarse filter, but no valid transaction proposal was extracted.';
		}

		return `Passed coarse filter, but no valid transaction proposal was extracted from ${units.length} planned unit(s).`;
	}

	private buildConflictingProposalsReason(conflict: ConflictingEmailFinanceProposalGroup): string {
		const amounts = this.uniqueStrings(conflict.proposals.map((candidate) =>
			`${candidate.proposal.amount.toFixed(2)} ${(candidate.proposal.currency || 'RUB').trim().toUpperCase()}`,
		));
		return `Multiple conflicting transaction proposals were extracted from the same email. Candidate amounts: ${amounts.join(', ')}.`;
	}

	private buildSourceContext(
		message: FinanceMailMessage,
		units: PlannedEmailFinanceUnit[],
		failureMessages: string[],
		options: {
			kind: 'pending-approval' | 'needs-attention';
			unitLabels: string[];
			candidateProposals?: MergedEmailFinanceProposal[];
		},
	): string {
		const lines = [
			`- Review Status: ${options.kind}`,
			`- Message ID: ${message.id}`,
			message.threadId ? `- Thread ID: ${message.threadId}` : '',
			message.from ? `- From: ${message.from}` : '',
			message.subject ? `- Subject: ${message.subject}` : '',
			message.receivedAt ? `- Received At: ${message.receivedAt}` : '',
			message.attachmentNames.length > 0
				? `- Attachments: ${message.attachmentNames.join(', ')}`
				: '- Attachments: none',
			'',
			'### Planned Units',
			...(units.length > 0 ? units.map((unit) => `- ${this.describeUnit(unit)}`) : ['- none']),
			'',
			`### Matched Units (${options.kind})`,
			...(options.unitLabels.length > 0 ? options.unitLabels.map((label) => `- ${label}`) : ['- none']),
			'',
			'### Failed Attempts',
			...(failureMessages.length > 0 ? this.uniqueStrings(failureMessages).map((messageValue) => `- ${messageValue}`) : ['- none']),
		];

		if (options.candidateProposals && options.candidateProposals.length > 0) {
			lines.push(
				'',
				'### Candidate Proposals',
				...options.candidateProposals.flatMap((candidate, index) => this.describeCandidateProposal(candidate, index + 1)),
			);
		}

		const links = this.extractHtmlLinks(message.htmlBody || message.htmlBodyPreview || '');
		if (links.length > 0) {
			lines.push('', '### HTML Links', ...links.map((link) => `- ${link}`));
		}

		const remoteReceiptLinks = this.extractRemoteReceiptLinksFromMessage(message);
		if (remoteReceiptLinks.length > 0) {
			lines.push('', '### Remote Receipt Links', ...remoteReceiptLinks.map((link) => `- ${link}`));
		}

		const bodyPreview = this.getBodyPreview(message);
		if (bodyPreview) {
			lines.push('', '### Body Preview', bodyPreview);
		}

		return lines.filter((value) => value !== '').join('\n');
	}

	private describeCandidateProposal(
		candidate: MergedEmailFinanceProposal,
		index: number,
	): string[] {
		const proposal = candidate.proposal;
		const details = [
			`- Candidate ${index}: ${proposal.type} ${proposal.amount.toFixed(2)} ${(proposal.currency || 'RUB').trim().toUpperCase()} at ${proposal.dateTime || 'unknown time'}`,
			`  Description: ${proposal.description || 'n/a'}`,
			`  Category: ${proposal.category || 'n/a'}`,
			`  Matched Units: ${candidate.unitLabels.join(', ') || 'none'}`,
		];

		const fiscalParts = [
			proposal.fn ? `fn=${proposal.fn}` : '',
			proposal.fd ? `fd=${proposal.fd}` : '',
			proposal.fp ? `fp=${proposal.fp}` : '',
		].filter((value) => value.length > 0);
		if (fiscalParts.length > 0) {
			details.push(`  Fiscal: ${fiscalParts.join(', ')}`);
		}

		return details;
	}

	private getBodyPreview(message: FinanceMailMessage): string {
		const textBody = message.textBody?.trim() || message.textBodyPreview?.trim();
		if (textBody) {
			return textBody.slice(0, 4000);
		}

		const htmlBody = message.htmlBody?.trim() || message.htmlBodyPreview?.trim() || '';
		return htmlBody
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, '\'')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 4000);
	}

	private extractHtmlLinks(html: string): string[] {
		const matches = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi);
		return this.uniqueStrings(
			Array.from(matches, (match) => match[1]?.trim() ?? '')
				.filter((value) => value.length > 0),
		);
	}

	private formatUnitLabel(unit: PlannedEmailFinanceUnit): string {
		return `${unit.kind}:${unit.label}`;
	}

	private describeUnit(unit: PlannedEmailFinanceUnit): string {
		const baseLabel = this.formatUnitLabel(unit);
		if (unit.kind === 'text' && unit.remoteArtifactUrl) {
			return `${baseLabel} (remote artifact: ${unit.remoteArtifactUrl})`;
		}
		return baseLabel;
	}

	private pickBestMessageArtifact(message: FinanceMailMessage): FinanceMailAttachment | null {
		const supportedAttachments = message.attachments.filter((attachment) => this.isSupportedArtifactAttachment(attachment));
		if (supportedAttachments.length === 0) {
			return null;
		}

		const sorted = supportedAttachments.slice().sort((left, right) => this.scoreAttachment(right) - this.scoreAttachment(left));
		return sorted[0] ?? null;
	}

	private getBestMessageArtifactFields(
		message: FinanceMailMessage,
		fallbackText?: string,
	): Pick<TransactionData, 'artifactBytes' | 'artifactFileName' | 'artifactMimeType'> {
		const attachment = this.pickBestMessageArtifact(message);
		if (attachment) {
			return this.toAttachmentArtifactFields(attachment);
		}

		return this.buildSyntheticMessageArtifact(message, fallbackText);
	}

	private isSupportedArtifactAttachment(attachment: FinanceMailAttachment): boolean {
		if (!attachment.contentBase64) {
			return false;
		}

		const fileName = attachment.fileName || '';
		const mimeType = attachment.mimeType?.toLowerCase() ?? '';
		return mimeType === 'application/pdf'
			|| mimeType.startsWith('image/')
			|| /\.(pdf|png|jpg|jpeg|webp|bmp)$/i.test(fileName);
	}

	private scoreAttachment(attachment: FinanceMailAttachment): number {
		const mimeType = attachment.mimeType?.toLowerCase() ?? '';
		let score = attachment.byteLength ?? 0;
		if (mimeType === 'application/pdf') {
			score += 5_000_000;
		}
		if (mimeType.startsWith('image/')) {
			score += 1_000_000;
		}
		return score;
	}

	private toAttachmentArtifactFields(attachment: FinanceMailAttachment | null): Pick<TransactionData, 'artifactBytes' | 'artifactFileName' | 'artifactMimeType'> {
		if (!attachment?.contentBase64) {
			return {};
		}

		return {
			artifactBytes: this.decodeBase64(attachment.contentBase64),
			artifactFileName: attachment.fileName,
			artifactMimeType: attachment.mimeType,
		};
	}

	private buildSyntheticMessageArtifact(
		message: FinanceMailMessage,
		fallbackText?: string,
	): Pick<TransactionData, 'artifactBytes' | 'artifactFileName' | 'artifactMimeType'> {
		const htmlBody = message.htmlBody?.trim() || message.htmlBodyPreview?.trim() || '';
		if (htmlBody) {
			return {
				artifactBytes: this.encodeUtf8(this.wrapHtmlEmailArtifact(message, htmlBody)),
				artifactFileName: `${this.buildMessageArtifactBaseName(message)}.html`,
				artifactMimeType: 'text/html',
			};
		}

		const textBody = message.textBody?.trim() || message.textBodyPreview?.trim() || '';
		if (textBody) {
			return {
				artifactBytes: this.encodeUtf8(this.wrapTextEmailArtifact(message, textBody)),
				artifactFileName: `${this.buildMessageArtifactBaseName(message)}.txt`,
				artifactMimeType: 'text/plain',
			};
		}

		const fallback = fallbackText?.trim();
		if (fallback) {
			return {
				artifactBytes: this.encodeUtf8(this.wrapTextEmailArtifact(message, fallback)),
				artifactFileName: `${this.buildMessageArtifactBaseName(message)}-context.txt`,
				artifactMimeType: 'text/plain',
			};
		}

		return {};
	}

	private buildMessageArtifactBaseName(message: FinanceMailMessage): string {
		const subject = (message.subject?.trim() || 'email-message')
			.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s._-]/g, '-')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 60);
		return subject || 'email-message';
	}

	private wrapHtmlEmailArtifact(message: FinanceMailMessage, htmlBody: string): string {
		const title = this.escapeHtml(message.subject?.trim() || 'Email Message');
		const metadataRows = this.buildEmailMetadataRows(message)
			.map((row) => `<div class="meta-row"><span class="meta-label">${this.escapeHtml(row.label)}:</span> <span class="meta-value">${this.escapeHtml(row.value)}</span></div>`)
			.join('\n');
		const remoteReceiptLinks = this.extractRemoteReceiptLinksFromMessage(message);
		const remoteLinksMarkup = remoteReceiptLinks.length > 0
			? [
				'<div class="remote-links">',
				'  <h2>Remote Receipt Links</h2>',
				'  <ul>',
				...remoteReceiptLinks.map((link) => `    <li><a href="${this.escapeHtml(link)}">${this.escapeHtml(link)}</a></li>`),
				'  </ul>',
				'</div>',
			].join('\n')
			: '';
		return [
			'<!DOCTYPE html>',
			'<html lang="en">',
			'<head>',
			'  <meta charset="utf-8">',
			`  <title>${title}</title>`,
			'  <style>',
			'    body { font-family: "Segoe UI", sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }',
			'    .shell { max-width: 960px; margin: 0 auto; background: #ffffff; border: 1px solid #dbe2ea; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }',
			'    .header { padding: 20px 24px; background: linear-gradient(135deg, #eff6ff, #f8fafc); border-bottom: 1px solid #dbe2ea; }',
			'    .header h1 { margin: 0 0 12px 0; font-size: 22px; line-height: 1.3; }',
			'    .meta-row { margin: 4px 0; font-size: 14px; }',
			'    .meta-label { font-weight: 600; color: #334155; }',
			'    .meta-value { color: #475569; word-break: break-word; }',
			'    .content { padding: 24px; background: #ffffff; }',
			'    .remote-links { margin: 0 24px 24px; padding: 16px 18px; border: 1px solid #dbe2ea; border-radius: 12px; background: #f8fafc; }',
			'    .remote-links h2 { margin: 0 0 12px 0; font-size: 16px; }',
			'    .remote-links ul { margin: 0; padding-left: 18px; }',
			'    .remote-links li { margin: 6px 0; }',
			'    .content img { max-width: 100%; height: auto; }',
			'    .content table { max-width: 100%; }',
			'  </style>',
			'</head>',
			'<body>',
			'  <div class="shell">',
			'    <div class="header">',
			`      <h1>${title}</h1>`,
			metadataRows ? `      ${metadataRows}` : '',
			'    </div>',
			remoteLinksMarkup ? `    ${remoteLinksMarkup}` : '',
			'    <div class="content">',
			htmlBody,
			'    </div>',
			'  </div>',
			'</body>',
			'</html>',
		].filter(Boolean).join('\n');
	}

	private wrapTextEmailArtifact(message: FinanceMailMessage, textBody: string): string {
		const metadataLines = this.buildEmailMetadataRows(message)
			.map((row) => `${row.label}: ${row.value}`);
		const remoteReceiptLinks = this.extractRemoteReceiptLinksFromMessage(message);
		return [
			'Email Message Snapshot',
			'======================',
			'',
			...metadataLines,
			...(remoteReceiptLinks.length > 0
				? [
					'',
					'Remote Receipt Links',
					'--------------------',
					...remoteReceiptLinks,
				]
				: []),
			'',
			'Body',
			'----',
			textBody,
			'',
		].join('\n');
	}

	private buildEmailMetadataRows(message: FinanceMailMessage): Array<{ label: string; value: string }> {
		const rows = [
			{ label: 'Message ID', value: message.id },
			message.threadId ? { label: 'Thread ID', value: message.threadId } : null,
			message.from ? { label: 'From', value: message.from } : null,
			message.subject ? { label: 'Subject', value: message.subject } : null,
			message.receivedAt ? { label: 'Received At', value: message.receivedAt } : null,
			message.attachmentNames.length > 0
				? { label: 'Attachments', value: message.attachmentNames.join(', ') }
				: { label: 'Attachments', value: 'none' },
		].filter((row): row is { label: string; value: string } => Boolean(row?.value));
		return rows;
	}

	private extractRemoteReceiptLinksFromMessage(message: FinanceMailMessage): string[] {
		const htmlLinks = this.extractHtmlLinks(message.htmlBody || message.htmlBodyPreview || '');
		const bodyLinks = this.extractLinksFromText([
			message.textBody ?? '',
			message.textBodyPreview ?? '',
			message.htmlBody ?? '',
			message.htmlBodyPreview ?? '',
		].join('\n'));
		return this.uniqueStrings([...htmlLinks, ...bodyLinks].filter((link) =>
			/(?:ozon\.ru\/my\/e-check\/download|check\.yandex\.ru|receipt|e-check)/i.test(link),
		));
	}

	private extractLinksFromText(value: string): string[] {
		const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
		return this.uniqueStrings(matches.map((match) => match.trim()));
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private decodeBase64(value: string): ArrayBuffer {
		if (typeof Buffer !== 'undefined') {
			const buffer = Buffer.from(value, 'base64');
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		}

		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes.buffer;
	}

	private encodeUtf8(value: string): ArrayBuffer {
		if (typeof TextEncoder !== 'undefined') {
			return new TextEncoder().encode(value).buffer;
		}

		if (typeof Buffer !== 'undefined') {
			const buffer = Buffer.from(value, 'utf8');
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		}

		const bytes = new Uint8Array(value.length);
		for (let index = 0; index < value.length; index += 1) {
			bytes[index] = value.charCodeAt(index) & 0xff;
		}
		return bytes.buffer;
	}

	private uniqueStrings(values: string[]): string[] {
		return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
	}
}
