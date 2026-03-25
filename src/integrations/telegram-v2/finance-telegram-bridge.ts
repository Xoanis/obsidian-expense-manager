import { App, TFile } from 'obsidian';
import { ExpenseService } from '../../services/expense-service';
import { ExpenseManagerSettings } from '../../settings';
import { TransactionData, TransactionType } from '../../types';
import { ProverkaChekaClient } from '../../utils/api-client';
import { PLUGIN_UNIT_NAME } from '../../utils/constants';
import {
	getTelegramBotApiV2,
	InputFocusState,
	TelegramBotApiV2,
	TelegramCallbackContext,
	TelegramCallbackPayload,
	TelegramFileDescriptor,
	TelegramHandlerResult,
	TelegramInlineKeyboard,
	TelegramMessageContext,
} from './client';
import { IParaCoreApi } from '../para-core/types';

const CALLBACK_ACTIONS = {
	startCapture: 'start-capture',
	projectBudgetPrompt: 'project-budget-prompt',
} as const;

type CaptureTarget = 'project' | 'area' | 'generic';

interface ParsedTelegramTransactionInput {
	amount: number;
	comment: string;
	area?: string;
	project?: string;
}

interface CallbackTokenState {
	kind: 'capture' | 'project-budget';
	path: string;
	page: number;
	createdAt: number;
	transactionType?: TransactionType;
	target?: Exclude<CaptureTarget, 'generic'>;
}

interface CaptureStartOptions {
	transactionType: TransactionType;
	target?: CaptureTarget;
	path?: string;
	page?: number;
	area?: string;
	project?: string;
	originLabel?: string;
}

export class FinanceTelegramBridgeV2 {
	private readonly api: TelegramBotApiV2 | null;
	private readonly callbackTokenTtlMs = 1000 * 60 * 30;
	private callbackTokenCounter = 0;
	private readonly callbackTokens = new Map<string, CallbackTokenState>();

	constructor(
		private readonly app: App,
		private readonly expenseService: ExpenseService,
		private readonly settings: ExpenseManagerSettings,
	) {
		this.api = getTelegramBotApiV2(app);
	}

	register(): boolean {
		if (!this.api) {
			return false;
		}

		this.api.registerMessageHandler(
			(message, processedBefore) => this.handleMessage(message, processedBefore),
			PLUGIN_UNIT_NAME,
		);
		this.api.registerCallbackHandler(
			(callback, processedBefore) => this.handleCallback(callback, processedBefore),
			PLUGIN_UNIT_NAME,
		);
		this.api.registerFocusedInputHandler(
			(message, focus) => this.handleFocusedInput(message, focus),
			PLUGIN_UNIT_NAME,
		);
		return true;
	}

	dispose(): void {
		this.api?.disposeHandlersForUnit(PLUGIN_UNIT_NAME);
	}

	registerParaCoreCardContributions(api: IParaCoreApi): void {
		api.registerTelegramCardContribution({
			id: 'finance.telegram-project-card',
			domainId: 'finance',
			target: 'project',
			order: 100,
			renderSection: async ({ path }) => this.renderProjectSection(path),
			buildInlineKeyboard: async ({ path, page }) => this.buildCaptureKeyboard('project', path, page),
		});

		api.registerTelegramCardContribution({
			id: 'finance.telegram-area-card',
			domainId: 'finance',
			target: 'area',
			order: 100,
			renderSection: async ({ path }) => this.renderAreaSection(path),
			buildInlineKeyboard: async ({ path, page }) => this.buildCaptureKeyboard('area', path, page),
		});
	}

	buildProjectBudgetMetadataKeyboard(path: string, page: number): TelegramInlineKeyboard {
		return [[{
			text: 'Budget',
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.projectBudgetPrompt,
				token: this.createCallbackToken({
					kind: 'project-budget',
					path,
					page,
				}),
			}),
		}]];
	}

	private async handleMessage(
		message: TelegramMessageContext,
		processedBefore: boolean,
	): Promise<TelegramHandlerResult> {
		if (processedBefore) {
			return { processed: false, answer: null };
		}

		if (!message.command) {
			return { processed: false, answer: null };
		}

		const command = message.command.name.toLowerCase();
		if (command !== 'expense' && command !== 'income') {
			return { processed: false, answer: null };
		}

		const transactionType: TransactionType = command === 'income' ? 'income' : 'expense';
		const args = message.command.args?.trim() ?? '';
		if (!args) {
			await this.beginCaptureFlow({
				transactionType,
				target: 'generic',
			});
			return {
				processed: true,
				answer: `Send the next message as ${transactionType}. You can send text or a receipt image.`,
			};
		}

		try {
			const parsed = this.parseArgs(args);
			if (!parsed || parsed.amount <= 0) {
				return {
					processed: true,
					answer: 'Invalid amount. Use `/expense 500 Lunch | area=Health | project=My Project` or call `/expense` and send the next message separately.',
				};
			}

			const data = this.makeTransactionData(transactionType, parsed.amount, parsed.comment, {
				area: parsed.area,
				project: parsed.project,
			});
			await this.expenseService.createTransaction(data);
			return {
				processed: true,
				answer: this.formatSuccessMessage(data, 'Saved from command.'),
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error saving transaction: ${(error as Error).message}`,
			};
		}
	}

	private async handleCallback(
		callback: TelegramCallbackContext,
		processedBefore: boolean,
	): Promise<TelegramHandlerResult> {
		if (processedBefore || !this.api) {
			return { processed: false, answer: null };
		}

		const payload = this.api.decodeCallbackPayload
			? this.api.decodeCallbackPayload(callback.data)
			: this.tryDecodeCallbackPayload(callback.data);
		if (!payload || payload.unit !== PLUGIN_UNIT_NAME) {
			return { processed: false, answer: null };
		}

		if (payload.action === CALLBACK_ACTIONS.projectBudgetPrompt) {
			if (!payload.token) {
				return { processed: true, answer: 'Budget action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'project-budget') {
				return { processed: true, answer: 'Budget action expired. Open the metadata menu again and retry.' };
			}

			const file = this.app.vault.getAbstractFileByPath(state.path);
			if (!(file instanceof TFile)) {
				return { processed: true, answer: 'Project note was not found.' };
			}

			await this.beginProjectBudgetFlow(state.path, state.page, callback.messageId);
			return {
				processed: true,
				answer: `Send finance budget for project "${file.basename}" as a number, or '-' to clear it.`,
			};
		}

		if (payload.action !== CALLBACK_ACTIONS.startCapture || !payload.token) {
			return { processed: false, answer: null };
		}

		const state = this.callbackTokens.get(payload.token);
		if (!state || state.kind !== 'capture') {
			return { processed: true, answer: 'Finance action expired. Open the card again and retry.' };
		}

		const file = this.app.vault.getAbstractFileByPath(state.path);
		if (!(file instanceof TFile)) {
			return { processed: true, answer: `${state.target} note was not found.` };
		}

		await this.beginCaptureFlow({
			transactionType: state.transactionType ?? 'expense',
			target: state.target ?? 'project',
			path: state.path,
			page: state.page,
			area: state.target === 'area' ? this.toExactWikiLink(file) : undefined,
			project: state.target === 'project' ? this.toExactWikiLink(file) : undefined,
			originLabel: `${state.target ?? 'project'} "${file.basename}"`,
		});

		return {
			processed: true,
			answer: `Send the next message for ${state.transactionType ?? 'expense'} in ${file.basename}. Text or receipt image are both supported.`,
		};
	}

	private async handleFocusedInput(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		const action = this.getFocusAction(focus);
		if (action !== 'finance.capture') {
			if (action === 'finance.project-budget') {
				return this.handleProjectBudgetFocusedInput(message, focus);
			}
			return { processed: false, answer: null };
		}

		if (message.command?.name?.toLowerCase() === 'cancel') {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance capture cancelled.' };
		}

		try {
			if (message.files.length > 0) {
				return this.handleFocusedFiles(message, focus);
			}

			const text = message.text?.trim();
			if (!text) {
				return {
					processed: true,
					answer: 'Send text like `500 Lunch` or send a receipt image with QR code.',
				};
			}

			const parsed = this.parseArgs(text);
			if (!parsed || parsed.amount <= 0) {
				return {
					processed: true,
					answer: 'Could not parse transaction text. Example: `500 Lunch | area=Health | project=My Project`.',
				};
			}
			const scopedMetadataError = this.validateScopedMetadata(focus, parsed);
			if (scopedMetadataError) {
				return {
					processed: true,
					answer: scopedMetadataError,
				};
			}

			const data = this.makeTransactionData(
				this.getFocusTransactionType(focus),
				parsed.amount,
				parsed.comment,
				this.mergeCaptureMetadata(
					{
						area: this.getFocusContextString(focus, 'area'),
						project: this.getFocusContextString(focus, 'project'),
					},
					parsed,
				),
			);
			await this.expenseService.createTransaction(data);
			return {
				processed: true,
				answer: this.formatSuccessMessage(data, 'Saved from focused input.'),
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error saving transaction: ${(error as Error).message}`,
			};
		}
	}

	private async handleFocusedFiles(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		if (!this.api) {
			return { processed: true, answer: 'Telegram API v2 is not available.' };
		}

		const file = message.files[0];
		if (!file) {
			return { processed: true, answer: 'No file found in the message.' };
		}
		if (!this.isSupportedReceiptFile(file)) {
			return { processed: true, answer: 'This file type is not supported yet. Send a photo with QR code or plain text.' };
		}

		const savedFile = await this.api.saveFileToVault(file, {
			folder: '__telegram-finance-intake',
			fileName: `${Date.now()}-${file.suggestedName.replace(/[\\/]/g, '-')}`,
			conflictStrategy: 'rename',
		});

		try {
			const arrayBuffer = await this.app.vault.readBinary(savedFile);
			const blob = new Blob([arrayBuffer], {
				type: file.mimeType || 'image/jpeg',
			});
			const client = new ProverkaChekaClient(
				this.settings.proverkaChekaApiKey,
				this.settings.localQrOnly,
			);
			const result = await client.processReceiptHybrid(blob);
			if (result.hasError) {
				return {
					processed: true,
					answer: `Receipt processing failed: ${result.error || 'Unknown QR error'}`,
				};
			}

			const captionMetadata = this.parseCaption(message.caption || '');
			const scopedMetadataError = this.validateScopedMetadata(focus, captionMetadata);
			if (scopedMetadataError) {
				return {
					processed: true,
					answer: scopedMetadataError,
				};
			}
			result.data.type = this.getFocusTransactionType(focus);
			result.data.source = 'telegram';
			result.data.area = captionMetadata.area ?? this.getFocusContextString(focus, 'area') ?? undefined;
			result.data.project = captionMetadata.project ?? this.getFocusContextString(focus, 'project') ?? undefined;
			if (captionMetadata.comment) {
				result.data.comment = captionMetadata.comment;
			}

			await this.expenseService.createTransaction(result.data);
			return {
				processed: true,
				answer: this.formatSuccessMessage(
					result.data,
					result.source === 'api' ? 'Saved from receipt via API.' : 'Saved from local QR.',
				),
			};
		} finally {
			await this.app.vault.delete(savedFile);
		}
	}

	private async beginCaptureFlow(options: CaptureStartOptions): Promise<void> {
		if (!this.api) {
			return;
		}

		await this.api.setInputFocus(PLUGIN_UNIT_NAME, {
			mode: 'next-message',
			expiresInMs: 1000 * 60 * 10,
			context: {
				action: 'finance.capture',
				transactionType: options.transactionType,
				target: options.target ?? 'generic',
				path: options.path,
				page: options.page,
				area: options.area,
				project: options.project,
			},
		});

		const targetHint = options.originLabel
			? `Context: ${options.originLabel}.`
			: 'Context: no preset project or area.';
		const metadataHint = options.target === 'project'
			? 'Project is already fixed by the current card. You may still add `| area=...` if needed.'
			: options.target === 'area'
				? 'Area is already fixed by the current card. You may still add `| project=...` if needed.'
				: 'Optional metadata can still be added as `| area=Health | project=My Project`.';
		await this.api.sendMessage(
			[
				`Send the next message for ${options.transactionType}.`,
				targetHint,
				'Supported now: plain text like `500 Lunch` or a receipt image with QR code.',
				metadataHint,
				'Use `/cancel` to stop this flow.',
			].join('\n'),
		);
	}

	private async renderProjectSection(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return null;
		}

		const summary = await this.expenseService.getProjectSummary(file);
		const budget = this.readBudget(file);
		const lines = [
			'Finance',
			`- Expenses: ${summary.totalExpenses.toFixed(2)} RUB`,
			`- Income: ${summary.totalIncome.toFixed(2)} RUB`,
			`- Balance: ${summary.balance.toFixed(2)} RUB`,
			`- Transactions: ${summary.transactionCount}`,
		];
		if (budget !== null) {
			const remaining = budget - summary.totalExpenses;
			const usage = budget === 0 ? 0 : (summary.totalExpenses / budget) * 100;
			lines.push(`- Budget: ${budget.toFixed(2)} RUB`);
			lines.push(`- Budget used: ${usage.toFixed(1)}%`);
			lines.push(`- Remaining: ${remaining.toFixed(2)} RUB`);
		}

		if (summary.recentTransactions.length > 0) {
			lines.push('', 'Recent transactions:');
			for (const transaction of summary.recentTransactions.slice(0, 3)) {
				const sign = transaction.type === 'expense' ? '-' : '+';
				lines.push(
					`- ${transaction.dateTime.slice(0, 10)} ${sign}${transaction.amount.toFixed(2)} ${transaction.currency} ${transaction.comment}`,
				);
			}
		}

		return lines.join('\n');
	}

	private async renderAreaSection(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return null;
		}

		const summary = await this.expenseService.getAreaSummary(file);
		const lines = [
			'Finance',
			`- Expenses: ${summary.totalExpenses.toFixed(2)} RUB`,
			`- Income: ${summary.totalIncome.toFixed(2)} RUB`,
			`- Balance: ${summary.balance.toFixed(2)} RUB`,
			`- Transactions: ${summary.transactionCount}`,
			`- Linked projects: ${summary.linkedProjectCount}`,
		];

		if (summary.recentTransactions.length > 0) {
			lines.push('', 'Recent transactions:');
			for (const transaction of summary.recentTransactions.slice(0, 3)) {
				const sign = transaction.type === 'expense' ? '-' : '+';
				lines.push(
					`- ${transaction.dateTime.slice(0, 10)} ${sign}${transaction.amount.toFixed(2)} ${transaction.currency} ${transaction.comment}`,
				);
			}
		}

		return lines.join('\n');
	}

	private async buildCaptureKeyboard(
		target: Exclude<CaptureTarget, 'generic'>,
		path: string,
		page: number,
	): Promise<TelegramInlineKeyboard> {
		return [[
			this.buildCaptureButton('expense', target, path, page),
			this.buildCaptureButton('income', target, path, page),
		]];
	}

	private buildCaptureButton(
		transactionType: TransactionType,
		target: Exclude<CaptureTarget, 'generic'>,
		path: string,
		page: number,
	) {
		return {
			text: transactionType === 'expense' ? 'Add Expense' : 'Add Income',
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.startCapture,
				token: this.createCallbackToken({
					kind: 'capture',
					transactionType,
					target,
					path,
					page,
				}),
			}),
		};
	}

	private createCallbackToken(state: Omit<CallbackTokenState, 'createdAt'>): string {
		this.cleanupExpiredCallbackTokens();
		this.callbackTokenCounter += 1;
		const token = this.callbackTokenCounter.toString(36);
		this.callbackTokens.set(token, {
			...state,
			createdAt: Date.now(),
		});
		return token;
	}

	private cleanupExpiredCallbackTokens(): void {
		const now = Date.now();
		for (const [token, state] of this.callbackTokens.entries()) {
			if (now - state.createdAt > this.callbackTokenTtlMs) {
				this.callbackTokens.delete(token);
			}
		}
	}

	private parseArgs(args: string): ParsedTelegramTransactionInput | null {
		const trimmed = args.trim();
		if (!trimmed) {
			return null;
		}

		const [head, ...metadataParts] = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
		if (!head) {
			return null;
		}

		const [amountStr, ...commentParts] = head.split(/\s+/);
		const amount = parseFloat(amountStr);
		const comment = commentParts.join(' ').trim();
		if (Number.isNaN(amount) || !comment) {
			return null;
		}

		const metadata = this.parseMetadataParts(metadataParts);
		return {
			amount,
			comment,
			area: metadata.area,
			project: metadata.project,
		};
	}

	private parseCaption(caption: string): { comment: string; area?: string; project?: string } {
		const parts = caption
			.split('|')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return { comment: '' };
		}

		const [comment, ...metadataParts] = parts;
		const metadata = this.parseMetadataParts(metadataParts);
		return {
			comment,
			area: metadata.area,
			project: metadata.project,
		};
	}

	private parseMetadataParts(parts: string[]): { area?: string; project?: string } {
		const result: { area?: string; project?: string } = {};
		for (const part of parts) {
			const [rawKey, ...rawValueParts] = part.split('=');
			if (!rawKey || rawValueParts.length === 0) {
				continue;
			}

			const key = rawKey.trim().toLowerCase();
			const rawValue = rawValueParts.join('=').trim();
			if (!rawValue) {
				continue;
			}

			if (key === 'area') {
				result.area = this.normalizeWikiLink(rawValue);
			}
			if (key === 'project') {
				result.project = this.normalizeWikiLink(rawValue);
			}
		}
		return result;
	}

	private makeTransactionData(
		type: TransactionType,
		amount: number,
		comment: string,
		metadata?: { area?: string; project?: string },
	): TransactionData {
		return {
			type,
			amount,
			currency: 'RUB',
			dateTime: new Date().toISOString(),
			comment,
			area: metadata?.area,
			project: metadata?.project,
			tags: ['telegram'],
			category: 'Other',
			source: 'telegram',
		};
	}

	private mergeCaptureMetadata(
		base: { area?: string | null; project?: string | null },
		override: { area?: string; project?: string },
	): { area?: string; project?: string } {
		return {
			area: override.area ?? base.area ?? undefined,
			project: override.project ?? base.project ?? undefined,
		};
	}

	private formatSuccessMessage(data: TransactionData, sourceText: string): string {
		const emoji = data.type === 'expense' ? '💸' : '💰';
		const lines = [
			`${emoji} Saved: ${data.amount.toFixed(2)} ${data.currency}`,
			data.comment,
			sourceText,
		];
		if (data.project) {
			lines.push(`Project: ${data.project}`);
		}
		if (data.area) {
			lines.push(`Area: ${data.area}`);
		}
		return lines.join('\n');
	}

	private isSupportedReceiptFile(file: TelegramFileDescriptor): boolean {
		if (file.kind === 'photo') {
			return true;
		}
		return Boolean(file.mimeType?.startsWith('image/'));
	}

	private getFocusAction(focus: InputFocusState): string | null {
		const action = focus.context?.action;
		return typeof action === 'string' ? action : null;
	}

	private getFocusTransactionType(focus: InputFocusState): TransactionType {
		const type = focus.context?.transactionType;
		return type === 'income' ? 'income' : 'expense';
	}

	private getFocusContextString(focus: InputFocusState, key: string): string | null {
		const value = focus.context?.[key];
		return typeof value === 'string' && value.trim() ? value : null;
	}

	private validateScopedMetadata(
		focus: InputFocusState,
		metadata: { area?: string; project?: string },
	): string | null {
		const target = focus.context?.target;
		if (target === 'project' && metadata.project) {
			return 'Project is already fixed by the current project card. Send the entry without `| project=...`.';
		}
		if (target === 'area' && metadata.area) {
			return 'Area is already fixed by the current area card. Send the entry without `| area=...`.';
		}
		return null;
	}

	private encodeCallbackPayload(payload: TelegramCallbackPayload): string {
		if (!this.api?.encodeCallbackPayload) {
			return JSON.stringify(payload);
		}
		return this.api.encodeCallbackPayload(payload);
	}

	private tryDecodeCallbackPayload(data: string): TelegramCallbackPayload | null {
		try {
			return JSON.parse(data) as TelegramCallbackPayload;
		} catch {
			return null;
		}
	}

	private normalizeWikiLink(value: string): string {
		const trimmed = value.trim();
		if (/^\[\[.*\]\]$/.test(trimmed)) {
			return trimmed;
		}
		return `[[${trimmed}]]`;
	}

	private toExactWikiLink(file: TFile): string {
		return `[[${file.path.replace(/\.md$/i, '')}]]`;
	}

	private readBudget(file: TFile): number | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) {
			return null;
		}

		if (Object.prototype.hasOwnProperty.call(frontmatter, 'finance_budget')) {
			const rawValue = frontmatter.finance_budget;
			if (rawValue === null || rawValue === undefined || rawValue === '') {
				return null;
			}

			const value = Number(rawValue);
			return Number.isFinite(value) ? value : null;
		}

		const legacyBudget = Number(frontmatter.budget);
		return Number.isFinite(legacyBudget) ? legacyBudget : null;
	}

	private async beginProjectBudgetFlow(
		path: string,
		page: number,
		messageId?: number,
	): Promise<void> {
		if (!this.api) {
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error('Project not found.');
		}

		await this.api.setInputFocus(PLUGIN_UNIT_NAME, {
			mode: 'next-text',
			expiresInMs: 1000 * 60 * 10,
			context: {
				action: 'finance.project-budget',
				path,
				page,
				messageId,
			},
		});
		await this.api.sendMessage(
			[
				`Send finance budget for project "${file.basename}".`,
				'',
				'Use a number like `15000` or `15000.50`, or send `-` to clear it.',
			].join('\n'),
		);
	}

	private async handleProjectBudgetFocusedInput(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		const path = this.getFocusContextString(focus, 'path');
		if (!path) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Project context expired. Open the metadata menu again.' };
		}

		const rawText = message.text?.trim();
		if (!rawText) {
			return {
				processed: true,
				answer: 'Send a numeric finance budget or `-` to clear it.',
			};
		}

		const budget = this.parseBudgetInput(rawText);
		if (budget === undefined) {
			return {
				processed: true,
				answer: 'Could not parse budget. Send a number like `15000` or `-` to clear it.',
			};
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Project not found.' };
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter.finance_budget = budget;
		});

		return {
			processed: true,
			answer: budget === null
				? `Finance budget cleared for "${file.basename}". Reopen Metadata to see the updated value.`
				: `Finance budget for "${file.basename}" set to ${budget.toFixed(2)} RUB. Reopen Metadata to see the updated value.`,
		};
	}

	private parseBudgetInput(rawText: string): number | null | undefined {
		if (rawText === '-') {
			return null;
		}

		const normalized = rawText.replace(',', '.');
		const value = Number(normalized);
		if (!Number.isFinite(value) || value < 0) {
			return undefined;
		}

		return value;
	}
}
