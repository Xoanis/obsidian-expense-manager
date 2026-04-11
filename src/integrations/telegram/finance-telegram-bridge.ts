import { App, TFile } from 'obsidian';
import { DuplicateTransactionMatch, ExpenseService } from '../../services/expense-service';
import { DuplicateMergeSession, DuplicateMergeWorkflowService } from '../../services/duplicate-merge-workflow-service';
import {
	FinanceReviewWorkflowService,
	RejectedReviewDisposition,
} from '../../services/finance-review-workflow-service';
import { ReportSyncService } from '../../services/report-sync-service';
import {
	TelegramChartService,
	TelegramChartType,
	TELEGRAM_CHART_DESCRIPTORS,
} from '../../services/telegram-chart-service';
import { ExpenseManagerSettings } from '../../settings';
import { TransactionData } from '../../types';
import {
	formatMonthlyReportMessages,
	formatMonthlySectionMessage,
	formatMonthlySummaryMessage,
	MonthlyReportSection,
} from '../../utils/report-formatters';
import { PLUGIN_UNIT_NAME } from '../../utils/constants';
import { parseBudgetInput } from '../../utils/budget-input';
import {
	FinanceIntakeIntent,
	FinanceIntakeService,
} from '../../services/finance-intake-service';
import { PendingFinanceProposalService } from '../../email-finance/review/pending-finance-proposal-service';
import {
	getTelegramBotApi,
	InputFocusState,
	TelegramBotApi,
	TelegramCallbackContext,
	TelegramCallbackPayload,
	TelegramFileDescriptor,
	TelegramHandlerResult,
	TelegramInlineKeyboard,
	TelegramMessageContext,
} from './client';
import { IParaCoreApi } from '../para-core/types';
import { getPluginLogger } from '../../utils/plugin-debug-log';

const CALLBACK_ACTIONS = {
	startCapture: 'sc',
	projectBudgetPrompt: 'pb',
	monthlyReportOpen: 'mr',
	monthlyChartSend: 'mc',
	reviewRefresh: 'rr',
	reviewShowPending: 'rp',
	reviewShowAttention: 'rt',
	reviewShowDuplicates: 'rd',
	reviewShowAll: 'ra',
	reviewOpenNextPending: 'rn',
	reviewOpenNextDuplicate: 'rx',
	proposalConfirm: 'pc',
	proposalSaveDraft: 'pd',
	proposalReject: 'pr',
	proposalSetCategory: 'ct',
	proposalSetDescription: 'ds',
	proposalSetProject: 'pp',
	proposalSetArea: 'pa',
	proposalSetDate: 'dt',
	proposalViewNote: 'vn',
	proposalOpenSelector: 'os',
	proposalSelectOption: 'so',
	proposalBack: 'bk',
} as const;

const CALLBACK_UNIT_ALIAS = 'f';

type CaptureTarget = 'project' | 'area' | 'generic';
type SelectorField = 'project' | 'area' | 'category';
type ReviewQueueMode = 'all' | 'pending' | 'attention' | 'duplicate';

interface CallbackTokenState {
	kind: 'capture' | 'project-budget' | 'monthly-report' | 'monthly-chart' | 'proposal' | 'review';
	createdAt: number;
	path?: string;
	page?: number;
	intent?: FinanceIntakeIntent;
	target?: Exclude<CaptureTarget, 'generic'>;
	monthKey?: string;
	section?: MonthlyReportSection;
	chartType?: TelegramChartType;
	proposalId?: string;
	menuField?: SelectorField;
	value?: string;
}

interface CaptureStartOptions {
	intent: FinanceIntakeIntent;
	target?: CaptureTarget;
	path?: string;
	page?: number;
	area?: string;
	project?: string;
	originLabel?: string;
}

interface PendingFinanceProposal {
	id: string;
	data: TransactionData;
	createdAt: number;
	updatedAt: number;
	sourceFilePath?: string;
}

export class FinanceTelegramBridge {
	private readonly api: TelegramBotApi | null;
	private readonly callbackTokenTtlMs = 1000 * 60 * 30;
	private callbackTokenCounter = 0;
	private readonly callbackTokens = new Map<string, CallbackTokenState>();
	private proposalCounter = 0;
	private readonly proposals = new Map<string, PendingFinanceProposal>();
	private readonly pendingProposalService: PendingFinanceProposalService;
	private readonly duplicateMergeWorkflowService: DuplicateMergeWorkflowService;

	constructor(
		private readonly app: App,
		private readonly expenseService: ExpenseService,
		private readonly reportSyncService: ReportSyncService,
		private readonly telegramChartService: TelegramChartService,
		private readonly financeIntakeService: FinanceIntakeService,
		private readonly financeReviewWorkflowService: FinanceReviewWorkflowService,
		private readonly settings: ExpenseManagerSettings,
	) {
		this.api = getTelegramBotApi(app);
		this.pendingProposalService = new PendingFinanceProposalService(this.expenseService, () => this.settings.defaultCurrency);
		this.duplicateMergeWorkflowService = new DuplicateMergeWorkflowService(this.app, this.expenseService);
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
		if (command === 'finance_summary') {
			try {
				const reportDate = this.parseMonthlyReportArgument(message.command.args);
				const report = await this.reportSyncService.generateStandardPeriodReport('month', reportDate);
				const previousReport = await this.reportSyncService.generateStandardPeriodReport(
					'month',
					new Date(reportDate.getFullYear(), reportDate.getMonth() - 1, 1),
				);
				return {
					processed: true,
					answer: formatMonthlySummaryMessage(report, previousReport),
				};
			} catch (error) {
				return {
					processed: true,
					answer: `Error generating finance summary: ${(error as Error).message}`,
				};
			}
		}
		if (command === 'finance_report') {
			try {
				const reportDate = this.parseMonthlyReportArgument(message.command.args);
				if (!this.api) {
					const report = await this.reportSyncService.generateStandardPeriodReport('month', reportDate);
					const previousReport = await this.reportSyncService.generateStandardPeriodReport(
						'month',
						new Date(reportDate.getFullYear(), reportDate.getMonth() - 1, 1),
					);
					const messages = formatMonthlyReportMessages(report, previousReport);
					return {
						processed: true,
						answer: messages[0] ?? 'No data for this month.',
					};
				}

				await this.sendOrEditMonthlyReport({
					date: reportDate,
					section: 'summary',
				});
				return {
					processed: true,
					answer: null,
				};
			} catch (error) {
				return {
					processed: true,
					answer: `Error generating finance report: ${(error as Error).message}`,
				};
			}
		}
		if (command === 'finance_budget') {
			const args = message.command.args?.trim() ?? '';
			if (!args) {
				await this.beginCurrentMonthBudgetFlow();
				return {
					processed: true,
					answer: 'Send the budget for the current month as a number like `50000` or `-` to clear it.',
				};
			}

			return this.applyCurrentMonthBudgetInput(args);
		}
		if (command === 'finance_review') {
			try {
				const mode = this.parseReviewQueueMode(message.command.args);
				if (this.api) {
					await this.showReviewQueueMessage(mode);
					return {
						processed: true,
						answer: null,
					};
				}
				return {
					processed: true,
					answer: await this.buildFinanceReviewQueueMessage(mode),
				};
			} catch (error) {
				return {
					processed: true,
					answer: `Error loading finance review queue: ${(error as Error).message}`,
				};
			}
		}
		if (command !== 'finance_record') {
			return { processed: false, answer: null };
		}

		const intent: FinanceIntakeIntent = 'neutral';
		const args = message.command.args?.trim() ?? '';
		if (!args) {
			await this.beginCaptureFlow({
				intent,
				target: 'generic',
			});
			return {
				processed: true,
				answer: null,
			};
		}

		let processingMessageId: number | undefined;
		try {
			const proposalRequest = {
				text: args,
				intent,
				knownCategories: this.getKnownCategories(intent),
				knownProjects: this.getKnownLinkedNotes('project'),
				knownAreas: this.getKnownLinkedNotes('area'),
			};
			const routingDecision = this.financeIntakeService.routeTextRequest(proposalRequest);
			processingMessageId = await this.beginAiProcessingFeedback(routingDecision);
			const data = await this.financeIntakeService.createTextProposal(proposalRequest);
			if (!data || data.amount <= 0) {
				if (typeof processingMessageId === 'number' && this.api?.editMessage) {
					await this.api.editMessage(processingMessageId, this.buildInvalidArgsPrompt(intent));
					return {
						processed: true,
						answer: null,
					};
				}
				return {
					processed: true,
					answer: this.buildInvalidArgsPrompt(intent),
				};
			}

			await this.sendProposal(data, processingMessageId);
			return {
				processed: true,
				answer: null,
			};
		} catch (error) {
			getPluginLogger().error('FinanceTelegramBridge.handleMessage: failed to prepare transaction', error);
			if (typeof processingMessageId === 'number' && this.api?.editMessage) {
				await this.api.editMessage(
					processingMessageId,
					`Error preparing transaction: ${(error as Error).message}`,
				);
				return {
					processed: true,
					answer: null,
				};
			}
			return {
				processed: true,
				answer: `Error preparing transaction: ${(error as Error).message}`,
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

		const payload = this.decodeCallbackPayload(callback.data);
		if (!payload || payload.unit !== PLUGIN_UNIT_NAME) {
			return { processed: false, answer: null };
		}

		if (payload.action === CALLBACK_ACTIONS.projectBudgetPrompt) {
			if (!payload.token) {
				return { processed: true, answer: 'Budget action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'project-budget' || !state.path || typeof state.page !== 'number') {
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

		if (payload.action === CALLBACK_ACTIONS.monthlyReportOpen) {
			if (!payload.token) {
				return { processed: true, answer: 'Report action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'monthly-report' || !state.monthKey) {
				return { processed: true, answer: 'Report action expired. Run /finance_report again.' };
			}

			try {
				await this.sendOrEditMonthlyReport({
					date: this.parseMonthKey(state.monthKey),
					section: state.section ?? 'summary',
					messageId: callback.messageId,
				});
				await this.api.answerCallbackQuery?.(callback.callbackId);
				return { processed: true, answer: null };
			} catch (error) {
				return {
					processed: true,
					answer: `Error opening finance report: ${(error as Error).message}`,
				};
			}
		}

		if (payload.action === CALLBACK_ACTIONS.monthlyChartSend) {
			if (!payload.token) {
				return { processed: true, answer: 'Chart action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'monthly-chart' || !state.monthKey || !state.chartType) {
				return { processed: true, answer: 'Chart action expired. Open /finance_report again.' };
			}

			try {
				const sent = await this.sendMonthlyReportChart(this.parseMonthKey(state.monthKey), state.chartType);
				await this.api.answerCallbackQuery?.(
					callback.callbackId,
					sent ? 'Chart sent' : 'No data for this chart',
				);
				return { processed: true, answer: null };
			} catch (error) {
				return {
					processed: true,
					answer: `Error generating chart: ${(error as Error).message}`,
				};
			}
		}

		if (
			payload.action === CALLBACK_ACTIONS.reviewRefresh
			|| payload.action === CALLBACK_ACTIONS.reviewShowPending
			|| payload.action === CALLBACK_ACTIONS.reviewShowAttention
			|| payload.action === CALLBACK_ACTIONS.reviewShowDuplicates
			|| payload.action === CALLBACK_ACTIONS.reviewShowAll
			|| payload.action === CALLBACK_ACTIONS.reviewOpenNextPending
			|| payload.action === CALLBACK_ACTIONS.reviewOpenNextDuplicate
		) {
			if (!payload.token) {
				return { processed: true, answer: 'Finance review action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'review') {
				return { processed: true, answer: 'Finance review queue expired. Run /finance_review again.' };
			}

			if (payload.action === CALLBACK_ACTIONS.reviewOpenNextPending) {
				return this.openNextPendingReviewProposal(callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.reviewOpenNextDuplicate) {
				return this.openNextDuplicateReviewProposal(callback.messageId);
			}

			const mode: ReviewQueueMode = payload.action === CALLBACK_ACTIONS.reviewShowPending
				? 'pending'
				: payload.action === CALLBACK_ACTIONS.reviewShowAttention
					? 'attention'
					: payload.action === CALLBACK_ACTIONS.reviewShowDuplicates
						? 'duplicate'
					: payload.action === CALLBACK_ACTIONS.reviewShowAll
						? 'all'
						: this.parseReviewQueueMode(state.value);
			await this.showReviewQueueMessage(mode, callback.messageId);
			await this.api.answerCallbackQuery?.(callback.callbackId);
			return { processed: true, answer: null };
		}

		if (
			payload.action === CALLBACK_ACTIONS.proposalConfirm
			|| payload.action === CALLBACK_ACTIONS.proposalSaveDraft
			|| payload.action === CALLBACK_ACTIONS.proposalReject
			|| payload.action === CALLBACK_ACTIONS.proposalSetCategory
			|| payload.action === CALLBACK_ACTIONS.proposalSetDescription
			|| payload.action === CALLBACK_ACTIONS.proposalSetProject
			|| payload.action === CALLBACK_ACTIONS.proposalSetArea
			|| payload.action === CALLBACK_ACTIONS.proposalSetDate
			|| payload.action === CALLBACK_ACTIONS.proposalViewNote
			|| payload.action === CALLBACK_ACTIONS.proposalOpenSelector
			|| payload.action === CALLBACK_ACTIONS.proposalSelectOption
			|| payload.action === CALLBACK_ACTIONS.proposalBack
		) {
			if (!payload.token) {
				return { processed: true, answer: 'Finance proposal action is missing context.' };
			}

			const state = this.callbackTokens.get(payload.token);
			if (!state || state.kind !== 'proposal' || !state.proposalId) {
				return { processed: true, answer: 'Finance proposal expired. Start the capture flow again.' };
			}

			if (payload.action === CALLBACK_ACTIONS.proposalConfirm) {
				return this.confirmProposal(state.proposalId, callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalSaveDraft) {
				return this.saveProposalAsDraft(state.proposalId, callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalReject) {
				return this.rejectProposal(state.proposalId, callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalSetDate) {
				await this.beginProposalDateFlow(state.proposalId, callback.messageId);
				return {
					processed: true,
					answer: 'Send a date like `2026-03-26`, `26.03.2026`, or `2026-03-26 18:30`.',
				};
			}
			if (payload.action === CALLBACK_ACTIONS.proposalSetDescription) {
				await this.beginProposalDescriptionFlow(state.proposalId, callback.messageId);
				return {
					processed: true,
					answer: 'Send the new description text for this finance proposal.',
				};
			}
			if (payload.action === CALLBACK_ACTIONS.proposalViewNote) {
				return this.sendProposalNotePreview(state.proposalId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalBack) {
				return this.renderProposal(state.proposalId, callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalOpenSelector) {
				return this.openProposalSelector(state, callback.messageId);
			}
			if (payload.action === CALLBACK_ACTIONS.proposalSelectOption) {
				return this.applyProposalSelection(state, callback.messageId);
			}

			const field: SelectorField = payload.action === CALLBACK_ACTIONS.proposalSetCategory
				? 'category'
				: payload.action === CALLBACK_ACTIONS.proposalSetProject
					? 'project'
					: 'area';
			return this.openProposalSelector({
				...state,
				menuField: field,
				page: 0,
			}, callback.messageId);
		}

		if (payload.action !== CALLBACK_ACTIONS.startCapture || !payload.token) {
			return { processed: false, answer: null };
		}

		const state = this.callbackTokens.get(payload.token);
		if (!state || state.kind !== 'capture' || !state.path || typeof state.page !== 'number') {
			return { processed: true, answer: 'Finance action expired. Open the card again and retry.' };
		}

		const file = this.app.vault.getAbstractFileByPath(state.path);
		if (!(file instanceof TFile)) {
			return { processed: true, answer: `${state.target} note was not found.` };
		}

		await this.beginCaptureFlow({
			intent: state.intent ?? 'neutral',
			target: state.target ?? 'project',
			path: state.path,
			page: state.page,
			area: state.target === 'area' ? this.toExactWikiLink(file) : undefined,
			project: state.target === 'project' ? this.toExactWikiLink(file) : undefined,
			originLabel: `${state.target ?? 'project'} "${file.basename}"`,
		});

		return {
			processed: true,
			answer: null,
		};
	}

	private async handleFocusedInput(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		const action = this.getFocusAction(focus);
		if (message.command?.name?.toLowerCase() === 'cancel' && action?.startsWith('finance.')) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance input cancelled.' };
		}
		if (action !== 'finance.capture') {
			if (action === 'finance.project-budget') {
				return this.handleProjectBudgetFocusedInput(message, focus);
			}
			if (action === 'finance.month-budget') {
				return this.handleCurrentMonthBudgetFocusedInput(message);
			}
			if (action === 'finance.proposal.date') {
				return this.handleProposalDateFocusedInput(message, focus);
			}
			if (action === 'finance.proposal.description') {
				return this.handleProposalDescriptionFocusedInput(message, focus);
			}
			return { processed: false, answer: null };
		}

		let processingMessageId: number | undefined;
		try {
			if (message.files.length > 0) {
				return this.handleFocusedFiles(message, focus);
			}

			const text = message.text?.trim();
			if (!text) {
				return {
					processed: true,
					answer: this.buildCapturePrompt(this.getFocusIntent(focus)),
				};
			}

			const scopedMetadata = this.financeIntakeService.extractMetadataHints(text);
			const scopedMetadataError = this.validateScopedMetadata(focus, scopedMetadata);
			if (scopedMetadataError) {
				return {
					processed: true,
					answer: scopedMetadataError,
				};
			}

			const proposalRequest = {
				text,
				intent: this.getFocusIntent(focus),
				area: this.getFocusContextString(focus, 'area') ?? undefined,
				project: this.getFocusContextString(focus, 'project') ?? undefined,
				knownCategories: this.getKnownCategories(this.getFocusIntent(focus)),
				knownProjects: this.getKnownLinkedNotes('project'),
				knownAreas: this.getKnownLinkedNotes('area'),
			};
			const routingDecision = this.financeIntakeService.routeTextRequest(proposalRequest);
			processingMessageId = await this.beginAiProcessingFeedback(routingDecision);
			const resolvedData = await this.financeIntakeService.createTextProposal(proposalRequest);
			if (!resolvedData || resolvedData.amount <= 0) {
				if (typeof processingMessageId === 'number' && this.api?.editMessage) {
					await this.api.editMessage(processingMessageId, this.buildInvalidArgsPrompt(this.getFocusIntent(focus)));
					return {
						processed: true,
						answer: null,
					};
				}
				return {
					processed: true,
					answer: this.buildInvalidArgsPrompt(this.getFocusIntent(focus)),
				};
			}
			await this.sendProposal(resolvedData, processingMessageId);
			return {
				processed: true,
				answer: null,
			};
		} catch (error) {
			getPluginLogger().error('FinanceTelegramBridge.handleFocusedInput: failed to prepare transaction', error);
			if (typeof processingMessageId === 'number' && this.api?.editMessage) {
				await this.api.editMessage(
					processingMessageId,
					`Error preparing transaction: ${(error as Error).message}`,
				);
				return {
					processed: true,
					answer: null,
				};
			}
			return {
				processed: true,
				answer: `Error preparing transaction: ${(error as Error).message}`,
			};
		}
	}

	private async handleFocusedFiles(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		if (!this.api) {
			return { processed: true, answer: 'Telegram API is not available.' };
		}

		const file = message.files[0];
		if (!file) {
			return { processed: true, answer: 'No file found in the message.' };
		}
		if (!this.isSupportedReceiptFile(file)) {
			return { processed: true, answer: 'This file type is not supported yet. Send an image, a PDF finance document, or plain text.' };
		}

		const savedFile = await this.api.saveFileToVault(file, {
			folder: '__telegram-finance-intake',
			fileName: `${Date.now()}-${file.suggestedName.replace(/[\\/]/g, '-')}`,
			conflictStrategy: 'rename',
		});

		let processingMessageId: number | undefined;
		try {
			const arrayBuffer = await this.app.vault.readBinary(savedFile);
			const captionMetadata = this.financeIntakeService.parseCaption(message.caption || '');
			const scopedMetadataError = this.validateScopedMetadata(focus, captionMetadata);
			if (scopedMetadataError) {
				return {
					processed: true,
					answer: scopedMetadataError,
				};
			}
			const proposalRequest = {
				bytes: arrayBuffer,
				fileName: file.suggestedName,
				mimeType: file.mimeType,
				caption: message.caption || '',
				intent: this.getFocusIntent(focus),
				area: this.getFocusContextString(focus, 'area') ?? undefined,
				project: this.getFocusContextString(focus, 'project') ?? undefined,
				knownCategories: this.getKnownCategories(this.getFocusIntent(focus)),
				knownProjects: this.getKnownLinkedNotes('project'),
				knownAreas: this.getKnownLinkedNotes('area'),
			};
			const routingDecision = this.financeIntakeService.routeReceiptRequest(proposalRequest);
			processingMessageId = await this.beginAiProcessingFeedback(routingDecision, 'file');
			const result = await this.financeIntakeService.createReceiptProposal(proposalRequest);

			await this.sendProposal(result.data, processingMessageId);
			return {
				processed: true,
				answer: null,
			};
		} catch (error) {
			if (typeof processingMessageId === 'number' && this.api.editMessage) {
				await this.api.editMessage(
					processingMessageId,
					`Error preparing receipt transaction: ${(error as Error).message}`,
				);
				return {
					processed: true,
					answer: null,
				};
			}
			return {
				processed: true,
				answer: `Error preparing receipt transaction: ${(error as Error).message}`,
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
				intent: options.intent,
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
				'Send the next record.',
				targetHint,
				this.buildCapturePrompt(options.intent),
				metadataHint,
				'Use `/cancel` to stop this flow.',
			].join('\n'),
		);
	}

	private async sendOrEditMonthlyReport(options: {
		date: Date;
		section: MonthlyReportSection;
		messageId?: number;
	}): Promise<void> {
		if (!this.api) {
			return;
		}

		const report = await this.reportSyncService.generateStandardPeriodReport('month', options.date);
		const previousReport = await this.reportSyncService.generateStandardPeriodReport(
			'month',
			new Date(options.date.getFullYear(), options.date.getMonth() - 1, 1),
		);
		const text = formatMonthlySectionMessage(report, options.section, previousReport);
		const inlineKeyboard = this.buildMonthlyReportKeyboard(options.date, options.section);

		if (typeof options.messageId === 'number' && this.api.editMessage) {
			await this.api.editMessage(options.messageId, text, { inlineKeyboard });
			return;
		}

		await this.api.sendMessage(text, { inlineKeyboard });
	}

	private buildMonthlyReportKeyboard(date: Date, activeSection: MonthlyReportSection): TelegramInlineKeyboard {
		if (activeSection === 'charts') {
			return this.buildMonthlyChartKeyboard(date);
		}

		const previousDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);
		const nextDate = new Date(date.getFullYear(), date.getMonth() + 1, 1);
		return [
			[
				this.buildMonthlyReportButton('Prev', previousDate, activeSection),
				this.buildMonthlyReportButton('Next', nextDate, activeSection),
			],
			[
				this.buildMonthlyReportButton(activeSection === 'summary' ? 'Summary •' : 'Summary', date, 'summary'),
				this.buildMonthlyReportButton(activeSection === 'categories' ? 'Categories •' : 'Categories', date, 'categories'),
				this.buildMonthlyReportButton(activeSection === 'top-expenses' ? 'Top •' : 'Top', date, 'top-expenses'),
			],
			[
				this.buildMonthlyReportButton(activeSection === 'projects' ? 'Projects •' : 'Projects', date, 'projects'),
				this.buildMonthlyReportButton(activeSection === 'areas' ? 'Areas •' : 'Areas', date, 'areas'),
				this.buildMonthlyReportButton('Charts', date, 'charts'),
			],
		];
	}

	private buildMonthlyChartKeyboard(date: Date): TelegramInlineKeyboard {
		const previousDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);
		const nextDate = new Date(date.getFullYear(), date.getMonth() + 1, 1);
		const chartButtons = TELEGRAM_CHART_DESCRIPTORS.map((chart) => this.buildMonthlyChartButton(chart.label, date, chart.type));
		return [
			[
				this.buildMonthlyReportButton('Prev', previousDate, 'charts'),
				this.buildMonthlyReportButton('Next', nextDate, 'charts'),
			],
			chartButtons,
			[
				this.buildMonthlyReportButton('Back', date, 'summary'),
			],
		];
	}

	private buildMonthlyReportButton(
		text: string,
		date: Date,
		section: MonthlyReportSection,
	) {
		return {
			text,
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.monthlyReportOpen,
				token: this.createCallbackToken({
					kind: 'monthly-report',
					monthKey: this.toMonthKey(date),
					section,
				}),
			}),
		};
	}

	private buildMonthlyChartButton(
		text: string,
		date: Date,
		type: TelegramChartType,
	) {
		return {
			text,
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.monthlyChartSend,
				token: this.createCallbackToken({
					kind: 'monthly-chart',
					monthKey: this.toMonthKey(date),
					chartType: type,
				}),
			}),
		};
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
			lines.push('', 'Recent records:');
			for (const transaction of summary.recentTransactions.slice(0, 3)) {
				const sign = transaction.type === 'expense' ? '-' : '+';
			lines.push(
				`- ${transaction.dateTime.slice(0, 10)} ${sign}${transaction.amount.toFixed(2)} ${transaction.currency} ${transaction.description}`,
			);
			}
		}

		return lines.join('\n');
	}

	private async sendMonthlyReportChart(date: Date, type: TelegramChartType): Promise<boolean> {
		if (!this.api?.sendPhoto) {
			return false;
		}

		const report = await this.reportSyncService.generateStandardPeriodReport('month', date);
		const chart = await this.telegramChartService.renderMonthlyChart(report, type);
		if (!chart) {
			return false;
		}

		await this.api.sendPhoto(chart.bytes, {
			caption: chart.caption,
			fileName: chart.fileName,
		});
		return true;
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
			lines.push('', 'Recent records:');
			for (const transaction of summary.recentTransactions.slice(0, 3)) {
				const sign = transaction.type === 'expense' ? '-' : '+';
				lines.push(
					`- ${transaction.dateTime.slice(0, 10)} ${sign}${transaction.amount.toFixed(2)} ${transaction.currency} ${transaction.description}`,
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
			this.buildCaptureButton(target, path, page),
		]];
	}

	private buildCaptureButton(
		target: Exclude<CaptureTarget, 'generic'>,
		path: string,
		page: number,
	) {
		return {
			text: 'Add finance record',
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.startCapture,
				token: this.createCallbackToken({
					kind: 'capture',
					intent: 'neutral',
					target,
					path,
					page,
				}),
			}),
		};
	}

	private createCallbackToken(state: Omit<CallbackTokenState, 'createdAt'>): string {
		this.cleanupExpiredCallbackTokens();
		this.cleanupExpiredProposals();
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

	private parseMonthlyReportArgument(rawArgs: string | undefined): Date {
		const value = rawArgs?.trim().toLowerCase() ?? '';
		const now = new Date();
		if (!value || value === 'current' || value === 'now' || value === 'this') {
			return new Date(now.getFullYear(), now.getMonth(), 1);
		}
		if (value === 'prev' || value === 'previous') {
			return new Date(now.getFullYear(), now.getMonth() - 1, 1);
		}

		const monthMatch = value.match(/^(\d{4})-(\d{2})$/);
		if (monthMatch) {
			const year = Number(monthMatch[1]);
			const month = Number(monthMatch[2]);
			if (month >= 1 && month <= 12) {
				return new Date(year, month - 1, 1);
			}
		}

		return new Date(now.getFullYear(), now.getMonth(), 1);
	}

	private toMonthKey(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
	}

	private parseMonthKey(value: string): Date {
		const match = value.match(/^(\d{4})-(\d{2})$/);
		if (!match) {
			const now = new Date();
			return new Date(now.getFullYear(), now.getMonth(), 1);
		}
		return new Date(Number(match[1]), Number(match[2]) - 1, 1);
	}

	private formatSuccessMessage(data: TransactionData, sourceText: string): string {
		const emoji = data.type === 'expense' ? '💸' : '💰';
		const lines = [
			`${emoji} Saved: ${data.amount.toFixed(2)} ${data.currency}`,
			data.description,
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

	private async sendProposal(
		data: TransactionData,
		messageId?: number,
		options?: { sourceFilePath?: string },
	): Promise<void> {
		if (!this.api) {
			return;
		}

		const proposal = this.createProposal(data, options);
		await this.showProposalMessage(proposal, messageId);
	}

	private async beginAiProcessingFeedback(
		decision: ReturnType<FinanceIntakeService['routeTextRequest']>,
		mode: 'text' | 'file' = 'text',
	): Promise<number | undefined> {
		if (!this.api || decision.providerKind !== 'ai') {
			return undefined;
		}

		getPluginLogger().info('FinanceTelegramBridge: starting AI processing feedback', decision);
		const sent = await this.api.sendMessage(mode === 'file'
			? [
				'Processing finance file...',
				'Image or PDF extraction can take a while on local or remote AI models.',
			].join('\n')
			: [
				'Processing finance input...',
				'This can take a while on local or remote AI models.',
			].join('\n'));
		return sent.messageId;
	}

	private createProposal(
		data: TransactionData,
		options?: { sourceFilePath?: string },
	): PendingFinanceProposal {
		this.cleanupExpiredProposals();
		this.proposalCounter += 1;
		const now = Date.now();
		const proposal: PendingFinanceProposal = {
			id: `fp-${this.proposalCounter.toString(36)}`,
			data: {
				...data,
				amount: Number(data.amount.toFixed(2)),
			},
			createdAt: now,
			updatedAt: now,
			sourceFilePath: options?.sourceFilePath,
		};
		this.proposals.set(proposal.id, proposal);
		return proposal;
	}

	private async renderProposal(
		proposalId: string,
		messageId?: number,
		footer?: string,
	): Promise<TelegramHandlerResult> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		await this.showProposalMessage(proposal, messageId, footer);
		return {
			processed: true,
			answer: null,
		};
	}

	private async showProposalMessage(
		proposal: PendingFinanceProposal,
		messageId?: number,
		footer?: string,
	): Promise<void> {
		if (!this.api) {
			return;
		}

		const keyboard = this.buildProposalKeyboard(proposal.id);
		const text = this.formatProposalMessage(proposal, footer);
		if (typeof messageId === 'number' && this.api.editMessage) {
			await this.api.editMessage(messageId, text, { inlineKeyboard: keyboard });
			return;
		}

		await this.api.sendMessage(text, { inlineKeyboard: keyboard });
	}

	private buildProposalKeyboard(proposalId: string): TelegramInlineKeyboard {
		const keyboard: TelegramInlineKeyboard = [
			[
				this.buildProposalButton('Confirm', CALLBACK_ACTIONS.proposalConfirm, proposalId),
				this.buildProposalButton('Save draft', CALLBACK_ACTIONS.proposalSaveDraft, proposalId),
				this.buildProposalButton('Reject', CALLBACK_ACTIONS.proposalReject, proposalId),
			],
			[
				this.buildProposalButton('Set category', CALLBACK_ACTIONS.proposalSetCategory, proposalId),
				this.buildProposalButton('Edit date', CALLBACK_ACTIONS.proposalSetDate, proposalId),
			],
			[
				this.buildProposalButton('Edit description', CALLBACK_ACTIONS.proposalSetDescription, proposalId),
			],
			[
				this.buildProposalButton('Set project', CALLBACK_ACTIONS.proposalSetProject, proposalId),
				this.buildProposalButton('Set area', CALLBACK_ACTIONS.proposalSetArea, proposalId),
			],
		];

		const proposal = this.proposals.get(proposalId);
		if (proposal?.sourceFilePath) {
			keyboard.push([
				this.buildProposalButton('View note', CALLBACK_ACTIONS.proposalViewNote, proposalId),
			]);
		}

		return keyboard;
	}

	private buildProposalButton(
		text: string,
		action: typeof CALLBACK_ACTIONS[keyof typeof CALLBACK_ACTIONS],
		proposalId: string,
	) {
		return {
			text,
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action,
				token: this.createCallbackToken({
					kind: 'proposal',
					proposalId,
				}),
			}),
		};
	}

	private formatProposalMessage(proposal: PendingFinanceProposal, footer?: string): string {
		const emoji = proposal.data.type === 'expense' ? '💸' : '💰';
		const lines = [
			`${emoji} Finance record`,
			`Type: ${proposal.data.type}`,
			`Amount: ${proposal.data.amount.toFixed(2)} ${proposal.data.currency}`,
			`Date: ${proposal.data.dateTime}`,
			`Description: ${proposal.data.description}`,
			`Category: ${proposal.data.category || 'Other'}`,
			`Project: ${proposal.data.project ?? 'not set'}`,
			`Area: ${proposal.data.area ?? 'not set'}`,
			`Source: ${proposal.data.source}`,
		];
		if (proposal.data.artifactFileName) {
			lines.push(`Artifact: ${proposal.data.artifactFileName}`);
		}
		lines.push(
			'',
			footer ?? (
				proposal.sourceFilePath
					? 'Confirm to mark this pending note as recorded, save draft to keep it pending approval, or refine the fields first.'
					: 'Confirm to save this record to the vault, save draft to keep it pending approval, or refine the context first.'
			),
		);
		return lines.join('\n');
	}

	private async buildFinanceReviewQueueMessage(mode: ReviewQueueMode = 'all'): Promise<string> {
		const pending = await this.expenseService.getPendingApprovalTransactions();
		const attention = await this.expenseService.getNeedsAttentionTransactions();
		const duplicates = await this.expenseService.getDuplicateTransactions();
		const lines = [
			'Finance review queue',
			`Pending approval: ${pending.length}`,
			`Needs attention: ${attention.length}`,
			`Duplicates: ${duplicates.length}`,
		];

		if (mode === 'all' || mode === 'pending') {
			lines.push('', ...this.formatReviewQueueSection('Pending approval', pending, 5));
		}

		if (mode === 'all' || mode === 'attention') {
			lines.push('', ...this.formatReviewQueueSection('Needs attention', attention, 5));
		}

		if (mode === 'all' || mode === 'duplicate') {
			lines.push('', ...this.formatReviewQueueSection('Duplicates', duplicates, 5));
		}

		if (pending.length === 0 && attention.length === 0 && duplicates.length === 0) {
			lines.push('', 'Queue is empty.');
		} else {
			lines.push('', 'Use the Obsidian finance review queue note for the full list. Duplicate merge still happens in Obsidian.');
		}

		return lines.join('\n');
	}

	private async showReviewQueueMessage(mode: ReviewQueueMode, messageId?: number): Promise<void> {
		if (!this.api) {
			return;
		}

		const pending = await this.expenseService.getPendingApprovalTransactions();
		const attention = await this.expenseService.getNeedsAttentionTransactions();
		const duplicates = await this.expenseService.getDuplicateTransactions();
		const text = await this.buildFinanceReviewQueueMessage(mode);
		const keyboard = this.buildReviewQueueKeyboard(mode, pending.length, attention.length, duplicates.length);
		if (typeof messageId === 'number' && this.api.editMessage) {
			await this.api.editMessage(messageId, text, { inlineKeyboard: keyboard });
			return;
		}

		await this.api.sendMessage(text, { inlineKeyboard: keyboard });
	}

	private formatReviewQueueSection(title: string, transactions: TransactionData[], limit: number): string[] {
		const lines = [`${title}:`];
		if (transactions.length === 0) {
			lines.push('- none');
			return lines;
		}

		for (const transaction of transactions.slice(0, limit)) {
			const timestamp = this.formatReviewQueueDate(transaction.dateTime);
			const amount = transaction.amount > 0
				? `${transaction.amount.toFixed(2)} ${transaction.currency}`
				: 'amount pending';
			lines.push(`- ${timestamp} | ${amount} | ${transaction.description}`);
		}

		if (transactions.length > limit) {
			lines.push(`- ...and ${transactions.length - limit} more`);
		}

		return lines;
	}

	private formatReviewQueueDate(value: string): string {
		console.log('Parsing date for review queue:', value);
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}

		return date.toISOString().replace('T', ' ').slice(0, 16);
	}

	private buildReviewQueueKeyboard(
		mode: ReviewQueueMode,
		pendingCount: number,
		attentionCount: number,
		duplicateCount: number,
	): TelegramInlineKeyboard {
		return [
			[
				this.buildReviewQueueButton(
					mode === 'all' ? '[All]' : 'All',
					CALLBACK_ACTIONS.reviewShowAll,
					'all',
				),
				this.buildReviewQueueButton(
					mode === 'pending' ? `[Pending ${pendingCount}]` : `Pending ${pendingCount}`,
					CALLBACK_ACTIONS.reviewShowPending,
					'pending',
				),
				this.buildReviewQueueButton(
					mode === 'attention' ? `[Attention ${attentionCount}]` : `Attention ${attentionCount}`,
					CALLBACK_ACTIONS.reviewShowAttention,
					'attention',
				),
				this.buildReviewQueueButton(
					mode === 'duplicate' ? `[Duplicates ${duplicateCount}]` : `Duplicates ${duplicateCount}`,
					CALLBACK_ACTIONS.reviewShowDuplicates,
					'duplicate',
				),
			],
			[
				this.buildReviewQueueButton('Refresh', CALLBACK_ACTIONS.reviewRefresh, mode),
				this.buildReviewQueueButton(
					pendingCount > 0 ? `Open next pending (${pendingCount})` : 'No pending items',
					pendingCount > 0 ? CALLBACK_ACTIONS.reviewOpenNextPending : CALLBACK_ACTIONS.reviewRefresh,
					mode,
				),
				this.buildReviewQueueButton(
					duplicateCount > 0 ? `Open next duplicate (${duplicateCount})` : 'No duplicates',
					duplicateCount > 0 ? CALLBACK_ACTIONS.reviewOpenNextDuplicate : CALLBACK_ACTIONS.reviewRefresh,
					mode,
				),
			],
		];
	}

	private buildReviewQueueButton(
		text: string,
		action: typeof CALLBACK_ACTIONS[keyof typeof CALLBACK_ACTIONS],
		mode: ReviewQueueMode,
	) {
		return {
			text,
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action,
				token: this.createCallbackToken({
					kind: 'review',
					value: mode,
				}),
			}),
		};
	}

	private parseReviewQueueMode(rawArgs?: string): ReviewQueueMode {
		const normalized = rawArgs?.trim().toLowerCase() ?? '';
		if (normalized === 'pending') {
			return 'pending';
		}
		if (normalized === 'attention' || normalized === 'needs-attention' || normalized === 'needs_attention') {
			return 'attention';
		}
		if (normalized === 'duplicate' || normalized === 'duplicates') {
			return 'duplicate';
		}
		return 'all';
	}

	private cleanupExpiredProposals(): void {
		const now = Date.now();
		for (const [proposalId, proposal] of this.proposals.entries()) {
			if (now - proposal.updatedAt > this.callbackTokenTtlMs) {
				this.proposals.delete(proposalId);
			}
		}
	}

	private async findDuplicateMatchForProposal(
		data: TransactionData,
		excludeFilePath?: string,
	): Promise<DuplicateTransactionMatch | null> {
		return this.expenseService.findDuplicateTransactionMatch({
			fn: data.fn,
			fd: data.fd,
			fp: data.fp,
			dateTime: data.dateTime,
			amount: data.amount,
			type: data.type,
			excludeFilePath,
		});
	}

	private buildDuplicateProposalTags(data: TransactionData): string[] {
		return Array.from(new Set([
			'finance',
			data.type,
			data.source,
			'duplicate',
			...(data.tags ?? []),
		]));
	}

	private async persistProposalAsDuplicate(
		proposal: PendingFinanceProposal,
		match: DuplicateTransactionMatch,
	): Promise<TFile> {
		if (!proposal.sourceFilePath) {
			return this.expenseService.createDuplicateTransaction(proposal.data, match);
		}

		const existingFile = this.app.vault.getAbstractFileByPath(proposal.sourceFilePath);
		if (!(existingFile instanceof TFile)) {
			throw new Error('Pending finance note was not found.');
		}

		const originalFile = match.transaction.file;
		if (!(originalFile instanceof TFile)) {
			throw new Error('Duplicate target note was not found.');
		}

		return this.expenseService.updateTransactionWithFileSync(existingFile, {
			...proposal.data,
			status: 'duplicate',
			duplicateOf: this.toExactWikiLink(originalFile),
			tags: this.buildDuplicateProposalTags(proposal.data),
		});
	}

	private async confirmProposal(
		proposalId: string,
		messageId?: number,
	): Promise<TelegramHandlerResult> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		try {
			const duplicateMatch = await this.findDuplicateMatchForProposal(
				proposal.data,
				proposal.sourceFilePath,
			);

			if (duplicateMatch) {
				const file = await this.persistProposalAsDuplicate(proposal, duplicateMatch);
				this.proposals.delete(proposalId);
				if (typeof messageId === 'number' && this.api?.editMessage) {
					await this.api.editMessage(
						messageId,
						this.formatProposalMessage(
							{
								...proposal,
								sourceFilePath: file.path,
							},
							proposal.sourceFilePath
								? 'Review item was marked as duplicate and kept in the vault for later merge.'
								: 'Duplicate note was saved instead of creating a second transaction.',
						),
					);
				}
				return {
					processed: true,
					answer: proposal.sourceFilePath
						? 'Finance review item marked as duplicate.'
						: 'Duplicate finance note saved.',
				};
			}

			if (proposal.sourceFilePath) {
				const file = this.app.vault.getAbstractFileByPath(proposal.sourceFilePath);
				if (!(file instanceof TFile)) {
					return { processed: true, answer: 'Pending finance note was not found.' };
				}

				await this.expenseService.updateTransactionWithFileSync(file, {
					...proposal.data,
					status: 'recorded',
				});
			} else {
				await this.expenseService.createTransaction(proposal.data);
			}
			this.proposals.delete(proposalId);
			if (typeof messageId === 'number' && this.api?.editMessage) {
				await this.api.editMessage(
					messageId,
					this.formatSuccessMessage(
						proposal.data,
						proposal.sourceFilePath
							? 'Confirmed from finance review queue.'
							: 'Saved from Telegram finance proposal.',
					),
				);
			}
			return {
				processed: true,
				answer: proposal.sourceFilePath ? 'Finance review item confirmed.' : 'Finance transaction saved.',
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error saving finance proposal: ${(error as Error).message}`,
			};
		}
	}

	private async rejectProposal(
		proposalId: string,
		messageId?: number,
	): Promise<TelegramHandlerResult> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal already expired.' };
		}

		try {
			this.proposals.delete(proposalId);
			let storedDisposition: RejectedReviewDisposition | null = null;
			let missingStoredNote = false;

			if (proposal.sourceFilePath) {
				const file = this.app.vault.getAbstractFileByPath(proposal.sourceFilePath);
				if (file instanceof TFile) {
					const result = await this.financeReviewWorkflowService.rejectStoredReviewItem(file);
					storedDisposition = result.disposition;
				} else {
					missingStoredNote = true;
				}
			}

			if (typeof messageId === 'number' && this.api?.editMessage) {
				await this.api.editMessage(
					messageId,
					this.formatProposalMessage(
						proposal,
						this.getRejectedProposalMessage(proposal.sourceFilePath, storedDisposition, missingStoredNote),
					),
				);
			}

			if (missingStoredNote) {
				return {
					processed: true,
					answer: 'Pending finance note was not found.',
				};
			}

			return {
				processed: true,
				answer: this.getRejectedProposalAnswer(proposal.sourceFilePath, storedDisposition),
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error rejecting finance proposal: ${(error as Error).message}`,
			};
		}
	}

	private async saveProposalAsDraft(
		proposalId: string,
		messageId?: number,
	): Promise<TelegramHandlerResult> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		try {
			let file: TFile;
			let savedAsDuplicate = false;
			if (proposal.sourceFilePath) {
				const existing = this.app.vault.getAbstractFileByPath(proposal.sourceFilePath);
				if (!(existing instanceof TFile)) {
					return { processed: true, answer: 'Pending finance note was not found.' };
				}

				file = await this.expenseService.updateTransactionWithFileSync(existing, {
					...proposal.data,
					status: 'pending-approval',
				});
			} else {
				const duplicateMatch = await this.findDuplicateMatchForProposal(proposal.data);
				if (duplicateMatch) {
					file = await this.persistProposalAsDuplicate(proposal, duplicateMatch);
					savedAsDuplicate = true;
				} else {
					file = await this.pendingProposalService.createPendingProposal({
						...proposal.data,
						status: 'pending-approval',
					});
				}
			}

			this.proposals.delete(proposalId);
			if (typeof messageId === 'number' && this.api?.editMessage) {
				await this.api.editMessage(
					messageId,
					this.formatProposalMessage(
						{
							...proposal,
							sourceFilePath: file.path,
						},
						savedAsDuplicate
							? 'Duplicate note was saved instead of adding another pending approval item.'
							: proposal.sourceFilePath
							? 'Draft saved with pending approval status. You can continue review later from /finance_review.'
							: 'Draft saved with pending approval status. You can continue review later from /finance_review.',
					),
				);
			}

			return {
				processed: true,
				answer: savedAsDuplicate
					? 'Duplicate finance note saved.'
					: proposal.sourceFilePath
					? 'Finance review item kept pending.'
					: 'Finance draft saved.',
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error saving finance draft: ${(error as Error).message}`,
			};
		}
	}

	private getRejectedProposalMessage(
		sourceFilePath: string | undefined,
		disposition: RejectedReviewDisposition | null,
		missingStoredNote: boolean,
	): string {
		if (!sourceFilePath) {
			return 'Proposal rejected. Nothing was written to the vault.';
		}
		if (missingStoredNote) {
			return 'Stored review note was not found. Nothing else was written to the vault.';
		}
		if (disposition === 'deleted') {
			return 'Review item rejected and deleted from the vault.';
		}
		return 'Review item rejected and moved to the archive.';
	}

	private getRejectedProposalAnswer(
		sourceFilePath: string | undefined,
		disposition: RejectedReviewDisposition | null,
	): string {
		if (!sourceFilePath) {
			return 'Finance proposal rejected.';
		}
		if (disposition === 'deleted') {
			return 'Finance review item deleted.';
		}
		return 'Finance review item rejected and archived.';
	}

	private async openNextPendingReviewProposal(messageId?: number): Promise<TelegramHandlerResult> {
		const pending = await this.expenseService.getPendingApprovalTransactions();
		const next = pending[0];
		if (!next?.file) {
			if (typeof messageId === 'number' && this.api?.editMessage) {
				await this.showReviewQueueMessage('pending', messageId);
			}
			return { processed: true, answer: 'There are no pending finance review items right now.' };
		}

		const proposal = this.createProposal({
			...next,
			status: 'pending-approval',
		}, {
			sourceFilePath: next.file.path,
		});
		await this.showProposalMessage(
			proposal,
			messageId,
			'This item is already saved in the vault as pending approval. Confirm to mark it as recorded.',
		);
		return { processed: true, answer: null };
	}

	private async openNextDuplicateReviewProposal(messageId?: number): Promise<TelegramHandlerResult> {
		if (!this.api) {
			return { processed: true, answer: 'Telegram integration is not available.' };
		}

		const duplicates = await this.expenseService.getDuplicateTransactions();
		const next = duplicates[0];
		if (!next?.file) {
			if (typeof messageId === 'number' && this.api.editMessage) {
				await this.showReviewQueueMessage('duplicate', messageId);
			}
			return { processed: true, answer: 'There are no duplicate finance items right now.' };
		}

		try {
			const session = await this.duplicateMergeWorkflowService.buildSession(next.file);
			const text = this.formatDuplicateReviewMessage(session, duplicates.length);
			const keyboard = this.buildDuplicateReviewKeyboard();
			if (typeof messageId === 'number' && this.api.editMessage) {
				await this.api.editMessage(messageId, text, { inlineKeyboard: keyboard });
			} else {
				await this.api.sendMessage(text, { inlineKeyboard: keyboard });
			}
			return { processed: true, answer: null };
		} catch (error) {
			return {
				processed: true,
				answer: `Error opening duplicate review: ${(error as Error).message}`,
			};
		}
	}

	private buildDuplicateReviewKeyboard(): TelegramInlineKeyboard {
		return [
			[
				this.buildReviewQueueButton('Back to duplicates', CALLBACK_ACTIONS.reviewShowDuplicates, 'duplicate'),
				this.buildReviewQueueButton('Next duplicate', CALLBACK_ACTIONS.reviewOpenNextDuplicate, 'duplicate'),
			],
			[
				this.buildReviewQueueButton('All queues', CALLBACK_ACTIONS.reviewShowAll, 'all'),
			],
		];
	}

	private formatDuplicateReviewMessage(session: DuplicateMergeSession, duplicateCount: number): string {
		const differingFields = session.fields.filter((field) => field.state !== 'equal');
		const differingSections = session.sections.filter((section) => section.state !== 'equal');
		const lines = [
			'Duplicate review',
			`Duplicates in queue: ${duplicateCount}`,
			`Original: ${session.originalFile.path}`,
			`Duplicate: ${session.duplicateFile.path}`,
			'',
			'Original summary:',
			`- ${this.formatDuplicateTransactionSummary(session.original)}`,
			'Duplicate summary:',
			`- ${this.formatDuplicateTransactionSummary(session.duplicate)}`,
			'',
			`Field differences: ${differingFields.length}`,
		];

		if (differingFields.length === 0) {
			lines.push('- none');
		} else {
			for (const field of differingFields.slice(0, 6)) {
				lines.push(
					`- ${field.label}: ${this.formatDuplicateCompareValue(field.originalValue)} -> ${this.formatDuplicateCompareValue(field.duplicateValue)}`,
				);
			}
			if (differingFields.length > 6) {
				lines.push(`- ...and ${differingFields.length - 6} more field difference(s)`);
			}
		}

		lines.push('', `Body section differences: ${differingSections.length}`);
		if (differingSections.length === 0) {
			lines.push('- none');
		} else {
			for (const section of differingSections.slice(0, 6)) {
				lines.push(`- ${section.label}`);
			}
			if (differingSections.length > 6) {
				lines.push(`- ...and ${differingSections.length - 6} more section difference(s)`);
			}
		}

		lines.push(
			'',
			'Telegram duplicate merge stays limited on purpose.',
			'Use the Obsidian command palette: "Open duplicate merge queue" to complete the merge safely.',
		);

		return this.truncateTelegramText(lines.join('\n'), 3800);
	}

	private formatDuplicateTransactionSummary(transaction: TransactionData): string {
		return [
			transaction.type,
			`${transaction.amount.toFixed(2)} ${transaction.currency}`,
			this.formatReviewQueueDate(transaction.dateTime),
			transaction.description || 'no description',
		].join(' | ');
	}

	private formatDuplicateCompareValue(value: string): string {
		const trimmed = value.trim();
		if (!trimmed) {
			return 'empty';
		}

		return this.truncateTelegramText(trimmed.replace(/\s+/g, ' '), 80);
	}

	private async sendProposalNotePreview(proposalId: string): Promise<TelegramHandlerResult> {
		if (!this.api) {
			return { processed: true, answer: 'Telegram integration is not available.' };
		}

		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}
		if (!proposal.sourceFilePath) {
			return { processed: true, answer: 'This proposal has not been saved as a note yet.' };
		}

		const file = this.app.vault.getAbstractFileByPath(proposal.sourceFilePath);
		if (!(file instanceof TFile)) {
			return { processed: true, answer: 'Finance note was not found.' };
		}

		const content = await this.app.vault.cachedRead(file);
		await this.api.sendMessage(this.formatProposalNotePreview(proposal, file, content));
		return {
			processed: true,
			answer: null,
		};
	}

	private async beginProposalDateFlow(
		proposalId: string,
		messageId?: number,
	): Promise<void> {
		if (!this.api) {
			return;
		}

		await this.api.setInputFocus(PLUGIN_UNIT_NAME, {
			mode: 'next-text',
			expiresInMs: 1000 * 60 * 10,
			context: {
				action: 'finance.proposal.date',
				proposalId,
				messageId,
			},
		});
	}

	private async beginProposalDescriptionFlow(
		proposalId: string,
		messageId?: number,
	): Promise<void> {
		if (!this.api) {
			return;
		}

		await this.api.setInputFocus(PLUGIN_UNIT_NAME, {
			mode: 'next-text',
			expiresInMs: 1000 * 60 * 10,
			context: {
				action: 'finance.proposal.description',
				proposalId,
				messageId,
			},
		});
	}

	private async handleProposalDateFocusedInput(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		const proposalId = this.getFocusContextString(focus, 'proposalId');
		if (!proposalId) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance proposal context expired.' };
		}

		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		const rawText = message.text?.trim();
		if (!rawText) {
			return {
				processed: true,
				answer: 'Send a date like `2026-03-26`, `26.03.2026`, or `2026-03-26 18:30`.',
			};
		}

		const parsedDate = this.parseProposalDateInput(rawText, proposal.data.dateTime);
		if (!parsedDate) {
			return {
				processed: true,
				answer: 'Could not parse the date. Use `YYYY-MM-DD`, `DD.MM.YYYY`, or add time like `2026-03-26 18:30`.',
			};
		}

		proposal.data.dateTime = parsedDate;
		proposal.updatedAt = Date.now();
		await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);

		const rawMessageId = focus.context?.messageId;
		const proposalMessageId = typeof rawMessageId === 'number' ? rawMessageId : undefined;
		await this.showProposalMessage(proposal, proposalMessageId, 'Date updated. Review the proposal and confirm when ready.');
		return {
			processed: true,
			answer: 'Date updated for the pending proposal.',
		};
	}

	private async handleProposalDescriptionFocusedInput(
		message: TelegramMessageContext,
		focus: InputFocusState,
	): Promise<TelegramHandlerResult> {
		const proposalId = this.getFocusContextString(focus, 'proposalId');
		if (!proposalId) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance proposal context expired.' };
		}

		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		const rawText = message.text?.trim();
		if (!rawText) {
			return {
				processed: true,
				answer: 'Send non-empty description text for this proposal.',
			};
		}

		proposal.data.description = rawText;
		proposal.updatedAt = Date.now();
		await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);

		const rawMessageId = focus.context?.messageId;
		const proposalMessageId = typeof rawMessageId === 'number' ? rawMessageId : undefined;
		await this.showProposalMessage(
			proposal,
			proposalMessageId,
			'Description updated. Review the proposal and confirm when ready.',
		);
		return {
			processed: true,
			answer: 'Description updated for the pending proposal.',
		};
	}

	private async openProposalSelector(
		state: CallbackTokenState,
		messageId?: number,
	): Promise<TelegramHandlerResult> {
		if (!state.proposalId || !state.menuField) {
			return { processed: true, answer: 'Finance proposal action is missing selector context.' };
		}

		const proposal = this.proposals.get(state.proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		await this.showProposalSelector(proposal, state.menuField, state.page ?? 0, messageId);
		return {
			processed: true,
			answer: null,
		};
	}

	private async applyProposalSelection(
		state: CallbackTokenState,
		messageId?: number,
	): Promise<TelegramHandlerResult> {
		if (!state.proposalId || !state.menuField) {
			return { processed: true, answer: 'Finance proposal action is missing selector context.' };
		}

		const proposal = this.proposals.get(state.proposalId);
		if (!proposal) {
			return { processed: true, answer: 'Finance proposal expired. Start capture again.' };
		}

		const nextValue = state.value === '__clear__' ? undefined : state.value;
		if (state.menuField === 'category') {
			proposal.data.category = nextValue ?? 'Other';
		} else {
			proposal.data[state.menuField] = nextValue;
		}
		proposal.updatedAt = Date.now();

		await this.showProposalMessage(
			proposal,
			messageId,
			`${this.getProposalFieldLabel(state.menuField)} updated. Confirm to write this transaction to the vault, or refine more fields first.`,
		);
		return {
			processed: true,
			answer: `${this.getProposalFieldLabel(state.menuField)} updated.`,
		};
	}

	private async showProposalSelector(
		proposal: PendingFinanceProposal,
		field: SelectorField,
		page: number,
		messageId?: number,
	): Promise<void> {
		if (!this.api) {
			return;
		}

		const options = this.getSelectorOptions(field, proposal);
		const pageSize = 7;
		const totalPages = Math.max(1, Math.ceil(options.length / pageSize));
		const safePage = Math.max(0, Math.min(page, totalPages - 1));
		const pageOptions = options.slice(safePage * pageSize, (safePage + 1) * pageSize);
		const currentValue = field === 'category'
			? proposal.data.category || 'Other'
			: proposal.data[field] ?? 'not set';
		const lines = [
			`Select ${this.getProposalFieldLabel(field).toLowerCase()}:`,
			`Current: ${currentValue}`,
		];
		if (totalPages > 1) {
			lines.push(`Page: ${safePage + 1}/${totalPages}`);
		}

		const keyboard: TelegramInlineKeyboard = pageOptions.map((option) => [{
			text: this.getSelectorButtonLabel(option.label, option.selected),
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.proposalSelectOption,
				token: this.createCallbackToken({
					kind: 'proposal',
					proposalId: proposal.id,
					menuField: field,
					page: safePage,
					value: option.value,
				}),
			}),
		}]);

		const navigationRow = this.buildSelectorNavigationRow(proposal.id, field, safePage, totalPages);
		if (navigationRow.length > 0) {
			keyboard.push(navigationRow);
		}
		keyboard.push([{
			text: 'Back',
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.proposalBack,
				token: this.createCallbackToken({
					kind: 'proposal',
					proposalId: proposal.id,
				}),
			}),
		}]);

		const text = lines.join('\n');
		if (typeof messageId === 'number' && this.api.editMessage) {
			await this.api.editMessage(messageId, text, { inlineKeyboard: keyboard });
			return;
		}

		await this.api.sendMessage(text, { inlineKeyboard: keyboard });
	}

	private buildSelectorNavigationRow(
		proposalId: string,
		field: SelectorField,
		page: number,
		totalPages: number,
	): TelegramInlineKeyboard[number] {
		const row: TelegramInlineKeyboard[number] = [];
		if (page > 0) {
			row.push(this.buildSelectorNavigationButton('Prev', proposalId, field, page - 1));
		}
		if (page < totalPages - 1) {
			row.push(this.buildSelectorNavigationButton('Next', proposalId, field, page + 1));
		}
		return row;
	}

	private buildSelectorNavigationButton(
		text: string,
		proposalId: string,
		field: SelectorField,
		page: number,
	) {
		return {
			text,
			callbackData: this.encodeCallbackPayload({
				unit: PLUGIN_UNIT_NAME,
				action: CALLBACK_ACTIONS.proposalOpenSelector,
				token: this.createCallbackToken({
					kind: 'proposal',
					proposalId,
					menuField: field,
					page,
				}),
			}),
		};
	}

	private getSelectorButtonLabel(label: string, selected: boolean): string {
		return selected ? `[x] ${label}` : label;
	}

	private formatProposalNotePreview(
		proposal: PendingFinanceProposal,
		file: TFile,
		content: string,
	): string {
		const body = this.stripYamlFrontmatter(content).trim();
		const lines = [
			'Finance note preview',
			`File: ${file.path}`,
			`Status: ${proposal.data.status ?? 'recorded'}`,
			`Date: ${proposal.data.dateTime}`,
			`Description: ${proposal.data.description}`,
			`Artifact: ${proposal.data.artifact ?? 'not set'}`,
		];

		if (body) {
			lines.push('', 'Current note body:', this.truncateTelegramText(body, 2800));
		}

		return this.truncateTelegramText(lines.join('\n'), 3800);
	}

	private stripYamlFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
	}

	private truncateTelegramText(value: string, maxLength: number): string {
		if (value.length <= maxLength) {
			return value;
		}

		return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
	}

	private getProposalFieldLabel(field: SelectorField): string {
		if (field === 'category') {
			return 'Category';
		}
		if (field === 'project') {
			return 'Project';
		}
		return 'Area';
	}

	private getSelectorOptions(
		field: SelectorField,
		proposal: PendingFinanceProposal,
	): Array<{ label: string; value: string; selected: boolean }> {
		if (field === 'category') {
			const currentCategory = proposal.data.category || 'Other';
			return this.getKnownCategories(proposal.data.type)
				.map((category) => ({
					label: category,
					value: category,
					selected: category === currentCategory,
				}));
		}

		const currentValue = proposal.data[field];
		const clearLabel = field === 'project' ? 'Clear project' : 'Clear area';
		const typedNotes = this.getTypedLinkedNoteEntries(field);
		const options = [
			{
				label: clearLabel,
				value: '__clear__',
				selected: !currentValue,
			},
			...typedNotes.map((item) => ({
				label: item.label,
				value: item.value,
				selected: item.value === currentValue,
			})),
		];

		if (currentValue && !options.some((option) => option.value === currentValue)) {
			options.splice(1, 0, {
				label: currentValue,
				value: currentValue,
				selected: true,
			});
		}

		return options;
	}

	private parseProposalDateInput(rawText: string, previousValue: string): string | null {
		const trimmed = rawText.trim();
		if (!trimmed) {
			return null;
		}

		const fallbackDate = new Date(previousValue);
		const baseDate = Number.isNaN(fallbackDate.getTime()) ? new Date() : fallbackDate;
		const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
		if (isoMatch) {
			const [, rawYear, rawMonth, rawDay, rawHour, rawMinute] = isoMatch;
			return this.buildProposalDateValue(
				Number(rawYear),
				Number(rawMonth),
				Number(rawDay),
				rawHour ? Number(rawHour) : baseDate.getHours(),
				rawMinute ? Number(rawMinute) : baseDate.getMinutes(),
			);
		}

		const ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?$/);
		if (ruMatch) {
			const [, rawDay, rawMonth, rawYear, rawHour, rawMinute] = ruMatch;
			return this.buildProposalDateValue(
				Number(rawYear),
				Number(rawMonth),
				Number(rawDay),
				rawHour ? Number(rawHour) : baseDate.getHours(),
				rawMinute ? Number(rawMinute) : baseDate.getMinutes(),
			);
		}

		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
	}

	private buildProposalDateValue(
		year: number,
		month: number,
		day: number,
		hour: number,
		minute: number,
	): string | null {
		const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
		if (
			Number.isNaN(parsed.getTime())
			|| parsed.getFullYear() !== year
			|| parsed.getMonth() !== month - 1
			|| parsed.getDate() !== day
		) {
			return null;
		}
		return parsed.toISOString();
	}

	private isSupportedReceiptFile(file: TelegramFileDescriptor): boolean {
		if (file.kind === 'photo') {
			return true;
		}
		return Boolean(
			file.mimeType?.startsWith('image/')
			|| file.mimeType?.toLowerCase() === 'application/pdf'
			|| file.suggestedName.toLowerCase().endsWith('.pdf'),
		);
	}

	private getFocusAction(focus: InputFocusState): string | null {
		const action = focus.context?.action;
		return typeof action === 'string' ? action : null;
	}

	private getFocusIntent(focus: InputFocusState): FinanceIntakeIntent {
		const intent = focus.context?.intent;
		if (intent === 'expense' || intent === 'income' || intent === 'neutral') {
			return intent;
		}
		return 'neutral';
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

	private buildCapturePrompt(intent: FinanceIntakeIntent): string {
		void intent;
		return 'For text, send `expense 500 Lunch` or `income 500 Salary`, use signed amounts like `-500 Lunch` or `+500 Salary`, or send raw receipt QR text like `t=20260316T1007&s=1550.00&fn=...`. Receipt images, screenshots, and PDF finance documents are also supported.';
	}

	private buildInvalidArgsPrompt(intent: FinanceIntakeIntent): string {
		void intent;
		return 'Could not parse transaction text. Use `/finance_record expense 500 Lunch | area=Health | project=Trip`, `/finance_record +5000 Bonus`, or send raw receipt QR text like `t=20260316T1007&s=1550.00&fn=...`.';
	}

	private encodeCallbackPayload(payload: TelegramCallbackPayload): string {
		if (payload.token) {
			return `${CALLBACK_UNIT_ALIAS}:${payload.action}:${payload.token}`;
		}
		if (!this.api?.encodeCallbackPayload) {
			return JSON.stringify(payload);
		}
		return this.api.encodeCallbackPayload(payload);
	}

	private decodeCallbackPayload(data: string): TelegramCallbackPayload | null {
		const compactMatch = data.match(/^([a-z]):([a-z]{2}):([a-z0-9]+)$/i);
		if (compactMatch) {
			const [, unitAlias, action, token] = compactMatch;
			if (unitAlias === CALLBACK_UNIT_ALIAS) {
				return {
					unit: PLUGIN_UNIT_NAME,
					action,
					token,
				};
			}
		}

		if (this.api?.decodeCallbackPayload) {
			const decoded = this.api.decodeCallbackPayload(data);
			if (decoded) {
				return decoded;
			}
		}

		try {
			return JSON.parse(data) as TelegramCallbackPayload;
		} catch {
			return null;
		}
	}

	private getKnownCategories(intent: FinanceIntakeIntent): string[] {
		const source = intent === 'income'
			? this.settings.incomeCategories
			: intent === 'expense'
				? this.settings.expenseCategories
				: [
					...this.settings.expenseCategories,
					...this.settings.incomeCategories,
				];
		return Array.from(new Set(source.filter((value) => value.trim()))).sort((left, right) => left.localeCompare(right));
	}

	private getKnownLinkedNotes(expectedType: 'project' | 'area'): string[] {
		return this.getTypedLinkedNoteEntries(expectedType).map((item) => item.value);
	}

	private getTypedLinkedNoteEntries(expectedType: 'project' | 'area'): Array<{ label: string; value: string }> {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.readFrontmatterType(file) === expectedType)
			.map((file) => ({
				label: file.basename,
				value: this.toExactWikiLink(file),
			}))
			.sort((left, right) => left.label.localeCompare(right.label));
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

	private readFrontmatterType(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatterType = cache?.frontmatter?.type;
		return typeof frontmatterType === 'string' ? frontmatterType : null;
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

	private async beginCurrentMonthBudgetFlow(): Promise<void> {
		if (!this.api) {
			return;
		}

		await this.api.setInputFocus(PLUGIN_UNIT_NAME, {
			mode: 'next-text',
			expiresInMs: 1000 * 60 * 10,
			context: {
				action: 'finance.month-budget',
			},
		});
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

		const budget = parseBudgetInput(rawText);
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

	private async handleCurrentMonthBudgetFocusedInput(
		message: TelegramMessageContext,
	): Promise<TelegramHandlerResult> {
		const rawText = message.text?.trim();
		if (!rawText) {
			return {
				processed: true,
				answer: 'Send the budget for the current month as a number like `50000` or `-` to clear it.',
			};
		}

		const parsedBudget = parseBudgetInput(rawText);
		if (parsedBudget === undefined) {
			return {
				processed: true,
				answer: 'Could not parse budget. Send a number like `50000` or `-` to clear it.',
			};
		}

		await this.api?.clearInputFocus(PLUGIN_UNIT_NAME);
		return this.applyCurrentMonthBudgetInput(rawText);
	}

	private async applyCurrentMonthBudgetInput(rawText: string): Promise<TelegramHandlerResult> {
		const budget = parseBudgetInput(rawText);
		if (budget === undefined) {
			return {
				processed: true,
				answer: 'Could not parse budget. Send a number like `50000` or `-` to clear it.',
			};
		}

		try {
			const currentMonth = new Date();
			const { file, report } = await this.reportSyncService.setStandardPeriodBudget('month', currentMonth, budget);
			this.expenseService.clearReportRenderCache(file.path);
			const monthLabel = this.formatBudgetMonthLabel(currentMonth);
			if (budget === null || !report.budget) {
				return {
					processed: true,
					answer: `Budget cleared for ${monthLabel}.`,
				};
			}

			return {
				processed: true,
				answer: [
					`Budget for ${monthLabel} set to ${report.budget.limit.toFixed(2)} RUB.`,
					`Spent: ${report.budget.spent.toFixed(2)} RUB.`,
					`Remaining: ${report.budget.remaining.toFixed(2)} RUB.`,
				].join('\n'),
			};
		} catch (error) {
			return {
				processed: true,
				answer: `Error setting current month budget: ${(error as Error).message}`,
			};
		}
	}

	private formatBudgetMonthLabel(date: Date): string {
		return date.toLocaleString('en-US', {
			month: 'long',
			year: 'numeric',
		});
	}
}
