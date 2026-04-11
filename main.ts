import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } from 'obsidian';
import {
	createDefaultEmailFinanceCoarseFilterRules,
	createDefaultEmailFinanceSyncState,
	DEFAULT_SETTINGS,
	ExpenseManagerSettings,
	formatEmailFinanceCoarseFilterRules,
	parseEmailFinanceCoarseFilterRules,
	type EmailFinanceSyncState,
} from './src/settings';
import { DashboardContributionMode } from './src/settings';
import { ExpenseService } from './src/services/expense-service';
import { AnalyticsService } from './src/services/analytics-service';
import { QrHandler } from './src/handlers/qr-handler';
import { FinanceReportSection, TransactionData, TransactionSaveMode } from './src/types';
import { registerAddFinanceRecordCommand } from './src/commands/add-finance-record';
import { registerFetchReceiptItemsCommand } from './src/commands/fetch-receipt-items';
import { registerGenerateReportCommand } from './src/commands/generate-report';
import { registerGenerateReportFileCommand } from './src/commands/generate-report-file';
import { registerGenerateCustomReportCommand } from './src/commands/generate-custom-report';
import { registerMigrateLegacyNotesCommand } from './src/commands/migrate-legacy-notes';
import { registerSetCurrentMonthBudgetCommand } from './src/commands/set-current-month-budget';
import { registerOpenFinanceReviewQueueCommand } from './src/commands/open-finance-review-queue';
import { registerSyncCurrentTransactionNoteCommand } from './src/commands/sync-current-transaction-note';
import { registerSyncFinanceEmailsCommand } from './src/email-finance/commands/sync-finance-emails';
import { getParaCoreApi } from './src/integrations/para-core/para-core-client';
import { registerFinanceDomain } from './src/integrations/para-core/register-finance-domain';
import { registerFinanceMetadataContributions } from './src/integrations/para-core/register-metadata-contributions';
import { registerFinanceTemplateContributions } from './src/integrations/para-core/register-template-contributions';
import { registerFinanceTelegramHelpContributions } from './src/integrations/para-core/register-telegram-help-contributions';
import { IParaCoreApi, RegisteredParaDomain } from './src/integrations/para-core/types';
import { FinanceTelegramBridge } from './src/integrations/telegram/finance-telegram-bridge';
import { getTelegramBotApi, TelegramBotApi } from './src/integrations/telegram/client';
import { formatPluginBuildInfo } from './src/build-info';
import { ReportSyncService } from './src/services/report-sync-service';
import { TelegramChartService } from './src/services/telegram-chart-service';
import { TelegramBudgetAlertService } from './src/services/telegram-budget-alert-service';
import { TelegramEmailSyncNotificationService } from './src/services/telegram-email-sync-notification-service';
import { MigrationService } from './src/services/migration-service';
import { FinanceIntakeService } from './src/services/finance-intake-service';
import { ReceiptEnrichmentService } from './src/services/receipt-enrichment-service';
import { EmailFinanceSyncService } from './src/email-finance/sync/email-finance-sync-service';
import { EmailFinanceSyncStateStore } from './src/email-finance/sync/email-finance-sync-state-store';
import { PendingFinanceProposalService } from './src/email-finance/review/pending-finance-proposal-service';
import { ReportPeriodModal } from './src/ui/report-period-modal';
import { ReportsModal } from './src/ui/reports-modal';
import { ExpenseModal } from './src/ui/expense-modal';
import { BudgetInputModal } from './src/ui/budget-input-modal';
import { FinanceRuleInputModal } from './src/ui/finance-rule-input-modal';
import { PLUGIN_UNIT_NAME } from './src/utils/constants';
import { parseBudgetInput } from './src/utils/budget-input';
import { buildFinanceReviewQueueNoteContent } from './src/review/finance-review-queue-note';
import {
	ConsolePluginLogger,
	createPluginLogger,
	openSharedRuntimeLog,
	setActivePluginLogger,
	type PluginLogger,
} from './src/utils/plugin-debug-log';

type FinanceRecordInputResult =
	| { kind: 'text'; value: string }
	| { kind: 'receipt-image' };

export default class ExpenseManagerPlugin extends Plugin {
	settings: ExpenseManagerSettings;
	
	private expenseService!: ExpenseService;
	private analyticsService!: AnalyticsService;
	private telegramApi: TelegramBotApi | null = null;
	private financeTelegramBridge: FinanceTelegramBridge | null = null;
	private paraCoreApi: IParaCoreApi | null = null;
	private financeDomain: RegisteredParaDomain | null = null;
	private reportSyncService!: ReportSyncService;
	private telegramChartService!: TelegramChartService;
	private telegramBudgetAlertService!: TelegramBudgetAlertService;
	private telegramEmailSyncNotificationService!: TelegramEmailSyncNotificationService;
	private financeIntakeService!: FinanceIntakeService;
	private receiptEnrichmentService!: ReceiptEnrichmentService;
	private emailFinanceSyncService!: EmailFinanceSyncService;
	private pendingFinanceProposalService!: PendingFinanceProposalService;
	private logger: PluginLogger = new ConsolePluginLogger('Expense Manager');
	private scheduledEmailFinanceSyncInterval: number | null = null;
	private emailFinanceSyncInFlight: Promise<void> | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize PARA Core integration if available
		this.initializeParaCoreIntegration();
		this.logger = createPluginLogger('Expense Manager', this.paraCoreApi);
		setActivePluginLogger(this.logger);
		this.logger.info(`Loading plugin (${formatPluginBuildInfo()})`);

		// Initialize services
		this.expenseService = new ExpenseService(this.app, this.settings, this.paraCoreApi, this.financeDomain);
		this.analyticsService = new AnalyticsService(this.expenseService);
		this.telegramBudgetAlertService = new TelegramBudgetAlertService(this.app, this.settings);
		this.telegramEmailSyncNotificationService = new TelegramEmailSyncNotificationService(this.app, this.settings);
		this.reportSyncService = new ReportSyncService(
			this.app,
			this.expenseService,
			this.settings,
			this.telegramBudgetAlertService,
		);
		this.telegramChartService = new TelegramChartService(this.reportSyncService);
		this.financeIntakeService = new FinanceIntakeService(this.settings, {
			logger: this.logger,
		});
		this.receiptEnrichmentService = new ReceiptEnrichmentService(this.app, this.settings);
		this.pendingFinanceProposalService = new PendingFinanceProposalService(this.expenseService, () => this.settings.defaultCurrency);
		this.emailFinanceSyncService = this.createEmailFinanceSyncService();
		this.registerParaCoreTelegramCardContributions();

		// Initialize Telegram handler if API is available
		await this.initializeTelegramIntegration();

		// Register commands
		registerAddFinanceRecordCommand(this);
		registerFetchReceiptItemsCommand(this);
		registerGenerateReportCommand(this);
		registerGenerateReportFileCommand(this);
		registerGenerateCustomReportCommand(this);
		registerMigrateLegacyNotesCommand(this);
		registerSetCurrentMonthBudgetCommand(this);
		registerOpenFinanceReviewQueueCommand(this);
		registerSyncCurrentTransactionNoteCommand(this);
		registerSyncFinanceEmailsCommand(this);
		this.addCommand({
			id: 'open-debug-log',
			name: 'Open shared runtime log',
			callback: async () => {
				await this.openDebugLog();
			},
		});

		// Add ribbon icon
		this.addRibbonIcon('wallet', 'Add finance record', () => {
			this.handleAddFinanceRecord();
		});

		// Add settings tab
		this.addSettingTab(new ExpenseManagerSettingTab(this.app, this));
		this.registerReportSyncListeners();
		await this.reportSyncService.initialize();
		this.configureScheduledEmailFinanceSync();

		// Show startup notice
		new Notice('Expense Manager loaded');
	}

	onunload() {
		this.clearScheduledEmailFinanceSyncInterval();
		this.logger.info('Plugin unloaded');
		this.reportSyncService?.destroy();
		this.telegramApi?.disposeHandlersForUnit(PLUGIN_UNIT_NAME);
	}

	async loadSettings() {
		const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as ExpenseManagerSettings;
		this.settings = {
			...loaded,
			emailFinanceCoarseFilterRules: Array.isArray(loaded.emailFinanceCoarseFilterRules) && loaded.emailFinanceCoarseFilterRules.length > 0
				? loaded.emailFinanceCoarseFilterRules
				: createDefaultEmailFinanceCoarseFilterRules(),
			emailFinanceSyncState: loaded.emailFinanceSyncState
				? {
					...createDefaultEmailFinanceSyncState(),
					...loaded.emailFinanceSyncState,
				}
				: createDefaultEmailFinanceSyncState(),
			emailFinanceSyncIntervalMinutes: Math.max(1, Math.round(Number(loaded.emailFinanceSyncIntervalMinutes) || DEFAULT_SETTINGS.emailFinanceSyncIntervalMinutes)),
			emailFinanceMaxMessagesPerRun: Math.max(1, Math.round(Number(loaded.emailFinanceMaxMessagesPerRun) || DEFAULT_SETTINGS.emailFinanceMaxMessagesPerRun)),
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeParaCoreIntegration();
		this.logger = createPluginLogger('Expense Manager', this.paraCoreApi);
		setActivePluginLogger(this.logger);
		this.expenseService = new ExpenseService(
			this.app,
			this.settings,
			this.paraCoreApi,
			this.financeDomain,
		);
		this.analyticsService = new AnalyticsService(this.expenseService);
		this.reportSyncService?.destroy();
		this.telegramBudgetAlertService = new TelegramBudgetAlertService(this.app, this.settings);
		this.telegramEmailSyncNotificationService = new TelegramEmailSyncNotificationService(this.app, this.settings);
		this.reportSyncService = new ReportSyncService(
			this.app,
			this.expenseService,
			this.settings,
			this.telegramBudgetAlertService,
		);
		this.telegramChartService = new TelegramChartService(this.reportSyncService);
		this.financeIntakeService = new FinanceIntakeService(this.settings, {
			logger: this.logger,
		});
		this.receiptEnrichmentService = new ReceiptEnrichmentService(this.app, this.settings);
		this.pendingFinanceProposalService = new PendingFinanceProposalService(this.expenseService, () => this.settings.defaultCurrency);
		this.emailFinanceSyncService = this.createEmailFinanceSyncService();
		this.registerParaCoreTelegramCardContributions();
		this.telegramApi?.disposeHandlersForUnit(PLUGIN_UNIT_NAME);
		await this.initializeTelegramIntegration();
		await this.reportSyncService.initialize();
		this.configureScheduledEmailFinanceSync();
	}

	async persistEmailFinanceSyncState(nextState: EmailFinanceSyncState) {
		this.settings.emailFinanceSyncState = nextState;
		await this.saveData(this.settings);
	}

	isParaCoreStorageManaged(): boolean {
		return this.financeDomain !== null;
	}

	getManagedExpenseDirectory(): string {
		return this.financeDomain ? `${this.financeDomain.recordsPath}/Transactions` : this.settings.expenseFolder;
	}

	async openDebugLog() {
		const file = await openSharedRuntimeLog(this.app, this.paraCoreApi);
		if (!file) {
			new Notice('Shared runtime log does not exist yet.');
			return;
		}

		await this.app.workspace.getLeaf(true).openFile(file);
	}

	async handleSyncFinanceEmails() {
		await this.runEmailFinanceSync({
			trigger: 'manual',
			showStartNotice: true,
			showResultNotice: true,
			showErrorNotice: true,
		});
	}

	async handleOpenFinanceReviewQueue() {
		try {
			const pending = await this.expenseService.getPendingApprovalTransactions();
			const attention = await this.expenseService.getNeedsAttentionTransactions();
			const path = await this.ensureFinanceReviewQueueNote();
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				new Notice('Finance review queue note is unavailable.');
				return;
			}

			await this.app.workspace.getLeaf(true).openFile(file);
			new Notice(
				`Finance review queue: ${pending.length} pending approval, ${attention.length} need attention.`,
				6000,
			);
		} catch (error) {
			new Notice(`Error opening finance review queue: ${(error as Error).message}`);
			this.logger.error('Failed to open finance review queue', error);
		}
	}

	async renderReportSection(
		section: FinanceReportSection,
		container: HTMLElement,
		reportFilePath: string,
	): Promise<void> {
		await this.expenseService.renderReportSection(section, container, reportFilePath);
	}

	async renderFinanceDashboard(
		container: HTMLElement,
		options: {
			mode: DashboardContributionMode;
			transactionsRoot: string;
			reportsRoot: string;
		},
	): Promise<void> {
		await this.expenseService.renderFinanceDashboard(container, options);
	}

	/**
	 * Register template contributions in PARA Core when available.
	 * The plugin still works in standalone mode if PARA Core is not installed.
	 */
	private initializeParaCoreIntegration() {
		this.paraCoreApi = getParaCoreApi(this.app);
		this.financeDomain = null;
		if (!this.paraCoreApi) {
			this.logger.info('PARA Core integration not available');
			return;
		}

		this.financeDomain = registerFinanceDomain(this.paraCoreApi);
		registerFinanceTemplateContributions(
			this.paraCoreApi,
			`${this.financeDomain.recordsPath}/Transactions`,
			this.financeDomain.attachmentsPath ?? 'Attachments/Finance',
			this.settings.dashboardContributionMode,
		);
		this.registerParaCoreMetadataContributions();
		this.logger.info('Registered PARA Core template contributions');
	}

	private registerParaCoreMetadataContributions() {
		if (!this.paraCoreApi) {
			return;
		}

		registerFinanceMetadataContributions(this.paraCoreApi, this.app, {
			buildProjectBudgetKeyboard: this.financeTelegramBridge
				? (path, page) => this.financeTelegramBridge?.buildProjectBudgetMetadataKeyboard(path, page) ?? null
				: undefined,
		});
	}

	private createEmailFinanceSyncService(): EmailFinanceSyncService {
		const syncStateStore = new EmailFinanceSyncStateStore(
			() => this.settings.emailFinanceSyncState,
			(nextState) => this.persistEmailFinanceSyncState(nextState),
		);

		return new EmailFinanceSyncService(
			() => this.settings,
			syncStateStore,
			this.financeIntakeService,
			this.pendingFinanceProposalService,
			{
				logger: this.logger,
			},
		);
	}

	private configureScheduledEmailFinanceSync(): void {
		this.clearScheduledEmailFinanceSyncInterval();
		if (!this.settings.enableScheduledEmailFinanceSync) {
			return;
		}

		const intervalMinutes = Math.max(1, this.settings.emailFinanceSyncIntervalMinutes);
		const intervalMs = intervalMinutes * 60 * 1000;
		this.scheduledEmailFinanceSyncInterval = window.setInterval(() => {
			void this.runEmailFinanceSync({
				trigger: 'scheduled',
				showStartNotice: false,
				showResultNotice: false,
				showErrorNotice: false,
			});
		}, intervalMs);
		this.registerInterval(this.scheduledEmailFinanceSyncInterval);
		this.logger.info('Scheduled email finance sync configured', {
			intervalMinutes,
		});
	}

	private clearScheduledEmailFinanceSyncInterval(): void {
		if (this.scheduledEmailFinanceSyncInterval !== null) {
			window.clearInterval(this.scheduledEmailFinanceSyncInterval);
			this.scheduledEmailFinanceSyncInterval = null;
		}
	}

	private async runEmailFinanceSync(options: {
		trigger: 'manual' | 'scheduled';
		showStartNotice: boolean;
		showResultNotice: boolean;
		showErrorNotice: boolean;
	}): Promise<void> {
		if (this.emailFinanceSyncInFlight) {
			this.logger.info('Skipped email finance sync because another run is already in progress', {
				trigger: options.trigger,
			});
			if (options.showErrorNotice) {
				new Notice('Finance email sync is already running.', 4000);
			}
			return this.emailFinanceSyncInFlight;
		}

		const runPromise = (async () => {
			if (options.showStartNotice) {
				new Notice('Finance email sync started...', 4000);
			}

			try {
				const result = await this.emailFinanceSyncService.syncNewMessages();
				await this.maybeSendTelegramEmailSyncNotification(result, options.trigger);
				if (options.showResultNotice) {
					new Notice(result.summaryText, 7000);
				}
			} catch (error) {
				if (options.showErrorNotice) {
					new Notice(`Error syncing finance emails: ${(error as Error).message}`);
				}
				this.logger.error(`Email finance sync failed (${options.trigger})`, error);
			}
		})();

		this.emailFinanceSyncInFlight = runPromise;
		try {
			await runPromise;
		} finally {
			if (this.emailFinanceSyncInFlight === runPromise) {
				this.emailFinanceSyncInFlight = null;
			}
		}
	}

	private async maybeSendTelegramEmailSyncNotification(
		result: Awaited<ReturnType<EmailFinanceSyncService['syncNewMessages']>>,
		trigger: 'manual' | 'scheduled',
	): Promise<void> {
		try {
			await this.telegramEmailSyncNotificationService.sendEmailSyncNotification(result, {
				trigger,
			});
		} catch (error) {
			this.logger.warn('Failed to send Telegram email sync notification', error);
		}
	}

	private async ensureFinanceReviewQueueNote(): Promise<string> {
		const managedTransactionsPath = this.getManagedExpenseDirectory();
		const path = this.paraCoreApi
			? this.paraCoreApi.getSettings().rootNotes.reviewNotePath
			: normalizePath(`${this.settings.expenseFolder}/Finance Review Queue.md`);
		const normalizedPath = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
		const content = buildFinanceReviewQueueNoteContent(managedTransactionsPath);
		if (existing instanceof TFile) {
			return normalizedPath;
		}

		const segments = normalizedPath.split('/').filter(Boolean);
		if (segments.length > 1) {
			const parentFolder = segments.slice(0, -1).join('/');
			await this.app.vault.createFolder(parentFolder).catch(() => undefined);
		}
		await this.app.vault.create(normalizedPath, content);
		return normalizedPath;
	}

	private registerParaCoreTelegramCardContributions() {
		if (!this.paraCoreApi || !this.financeTelegramBridge) {
			return;
		}

		this.financeTelegramBridge.registerParaCoreCardContributions(this.paraCoreApi);
	}

	private registerParaCoreTelegramHelpContributions() {
		if (!this.paraCoreApi) {
			return;
		}

		registerFinanceTelegramHelpContributions(this.paraCoreApi);
	}

	/**
	 * Command handlers
	 */
	async handleAddFinanceRecord() {
		const input = await this.openFinanceRecordInputModal();
		if (!input) {
			return;
		}

		if (input.kind === 'receipt-image') {
			await this.handleReceiptFinanceRecord();
			return;
		}

		const proposal = await this.financeIntakeService.createTextProposal({
			text: input.value,
			intent: 'neutral',
			source: 'manual',
		});
		if (!proposal || proposal.amount <= 0) {
			new Notice(
				'Could not parse the record. Use `expense 500 Lunch`, `income 50000 Salary`, `-500 Taxi`, `+5000 Bonus`, or raw receipt QR text.',
			);
			return;
		}

		await this.reviewFinanceProposal(proposal);
	}

	private async handleReceiptFinanceRecord() {
		const handler = new QrHandler(
			this.app,
			this.settings
		);

		const result = await handler.handle();
		
		if (result.success && result.data) {
			await this.saveTransaction(result.data, {
				mode: result.saveMode ?? 'recorded',
			});
		} else if (result.error && result.error !== 'User cancelled') {
			new Notice(result.error);
		}
	}

	/**
	 * Generate monthly report
	 */
	async handleGenerateReport() {
		try {
			const report = await this.reportSyncService.generateCurrentMonthReport();
			const modal = new ReportsModal(this.app, report, this.expenseService);
			modal.open();
		} catch (error) {
			new Notice(`Error generating report: ${(error as Error).message}`);
		}
	}

	/**
	 * Generate monthly report and save as file directly
	 */
	async handleGenerateReportFile() {
		try {
			const report = await this.reportSyncService.generateCurrentMonthReport();
			const file = await this.expenseService.saveReportAsFile(report);
			new Notice(`Report saved to ${file.path}`);
			
			// Open the file
			const leaf = this.app.workspace.getLeaf();
			await leaf.openFile(file);
		} catch (error) {
			new Notice(`Error generating report: ${(error as Error).message}`);
			this.logger.error('Failed to save generated report file', error);
		}
	}

	async handleSetCurrentMonthBudget() {
		const monthLabel = new Date().toLocaleString('en-US', {
			month: 'long',
			year: 'numeric',
		});
		const value = await new Promise<string | null>((resolve) => {
			const modal = new BudgetInputModal(
				this.app,
				'Set current month budget',
				`Enter the budget for ${monthLabel}. Use "-" to clear the stored budget.`,
				'50000',
			);

			modal.onSubmit = (submittedValue) => resolve(submittedValue);
			modal.onCancel = () => resolve(null);
			modal.open();
		});
		if (value === null) {
			return;
		}

		const budget = parseBudgetInput(value);
		if (budget === undefined) {
			new Notice('Could not parse budget. Use a number like 50000 or "-" to clear it.');
			return;
		}

		try {
			const { file } = await this.reportSyncService.setStandardPeriodBudget('month', new Date(), budget);
			this.expenseService.clearReportRenderCache(file.path);
			new Notice(
				budget === null
					? `Budget cleared for ${monthLabel}.`
					: `Budget for ${monthLabel} set to ${budget.toFixed(2)} ${this.settings.defaultCurrency}.`,
			);
		} catch (error) {
			new Notice(`Error setting current month budget: ${(error as Error).message}`);
			this.logger.error('Failed to set current month budget', error);
		}
	}

	canFetchReceiptItemsFromActiveNote(): boolean {
		return this.receiptEnrichmentService.canEnrichFile(this.app.workspace.getActiveFile());
	}

	async handleFetchReceiptItemsFromActiveNote() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('Open a finance transaction note first.');
			return;
		}

		try {
			const result = await this.receiptEnrichmentService.enrichFile(file);
			new Notice(
				result.itemCount > 0
					? `Fetched ${result.itemCount} receipt item(s) from ProverkaCheka.`
					: 'Receipt was verified via ProverkaCheka, but no item details were returned.',
			);
		} catch (error) {
			new Notice(`Could not fetch receipt items: ${(error as Error).message}`);
			this.logger.error('Failed to enrich receipt from ProverkaCheka', error);
		}
	}

	async handleSyncCurrentFinanceNoteStorage() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('Open a finance transaction note first.');
			return;
		}
		if (!this.expenseService.isTransactionFile(file)) {
			new Notice('Open a managed finance transaction note first.');
			return;
		}

		const previousPath = file.path;
		try {
			const updatedFile = await this.expenseService.syncTransactionFileStorage(file);
			if (updatedFile.path === previousPath) {
				new Notice('Finance note filename and folder are already in sync.');
				return;
			}

			await this.app.workspace.getLeaf(false).openFile(updatedFile);
			new Notice(`Finance note moved to ${updatedFile.path}`);
		} catch (error) {
			new Notice(`Could not sync finance note filename and folder: ${(error as Error).message}`);
			this.logger.error('Failed to sync finance note filename and folder', error);
		}
	}

	/**
	 * Save transaction to vault
	 */
	private async saveTransaction(
		data: TransactionData,
		options?: { mode?: TransactionSaveMode },
	) {
		const mode = options?.mode ?? 'recorded';
		try {
			const isDuplicate = await this.expenseService.isDuplicateTransaction(
				data.fn,
				data.fd,
				data.fp,
				data.dateTime,
				data.amount,
				data.type,
			);
			if (isDuplicate) {
				new Notice(`⚠️ Duplicate transaction detected! Skipping.`);
				this.logger.info('Duplicate transaction prevented', data.description);
				return;
			}
			
			if (mode === 'draft') {
				const file = await this.pendingFinanceProposalService.createPendingProposal({
					...data,
					status: 'pending-approval',
				});

				if (this.settings.showConfirmationNotice) {
					new Notice(`Draft saved for review: ${data.amount.toFixed(2)} ${data.currency} - ${data.description}`, 5000);
				}
				this.logger.info('Finance draft saved', {
					path: file.path,
					source: data.source,
				});
				return;
			}

			const file = await this.expenseService.createTransaction(data);
			this.expenseService.clearReportRenderCache();
			this.reportSyncService.scheduleAutoSync(`transaction-saved:${file.path}`);
			
			if (this.settings.showConfirmationNotice) {
				const emoji = data.type === 'expense' ? '💸' : '💰';
				new Notice(`${emoji} Saved: ${data.amount.toFixed(2)} ${data.currency} - ${data.description}`);
			}
		} catch (error) {
			new Notice(`Error saving transaction: ${(error as Error).message}`);
			this.logger.error('Failed to save transaction', error);
		}
	}

	/**
	 * Initialize Telegram integration
	 */
	private async initializeTelegramIntegration() {
		if (!this.settings.enableTelegramIntegration) {
			return;
		}

		this.telegramApi = null;
		this.financeTelegramBridge = null;

		try {
			this.telegramApi = getTelegramBotApi(this.app);
			if (!this.telegramApi) {
				this.logger.info('Telegram integration skipped: API is unavailable');
				return;
			}

			this.financeTelegramBridge = new FinanceTelegramBridge(
				this.app,
				this.expenseService,
				this.reportSyncService,
				this.telegramChartService,
				this.financeIntakeService,
				this.settings,
			);
			if (!this.financeTelegramBridge.register()) {
				this.logger.warn('Telegram integration failed: unable to register Telegram bridge');
				return;
			}

			this.registerParaCoreMetadataContributions();
			this.registerParaCoreTelegramCardContributions();
			this.registerParaCoreTelegramHelpContributions();
			this.logger.info('Telegram integration initialized');
		} catch (error) {
			this.logger.warn('Telegram integration not available', error);
		}
	}

	private async openFinanceRecordInputModal(): Promise<FinanceRecordInputResult | null> {
		return new Promise((resolve) => {
			const modal = new FinanceRuleInputModal(
				this.app,
				'Add finance record',
				'Enter finance text, paste raw receipt QR text, or switch to receipt image capture. You can add `| area=...` and `| project=...` metadata.',
				'expense 500 Lunch | area=Health',
				'Use receipt image',
			);

			modal.onSubmit = (value) => resolve({ kind: 'text', value });
			modal.onSecondaryAction = () => resolve({ kind: 'receipt-image' });
			modal.onCancel = () => resolve(null);
			modal.open();
		});
	}

	private async reviewFinanceProposal(
		proposal: TransactionData,
	): Promise<void> {
		await new Promise<void>((resolve) => {
			const modal = new ExpenseModal(
				this.app,
				proposal.type,
				proposal.currency || this.settings.defaultCurrency,
				proposal.type === 'expense' ? this.settings.expenseCategories : this.settings.incomeCategories,
				proposal,
			);

			modal.onComplete = async (data: TransactionData, saveMode: TransactionSaveMode = 'recorded') => {
				data.details = proposal.details;
				data.fn = proposal.fn;
				data.fd = proposal.fd;
				data.fp = proposal.fp;
				data.artifact = proposal.artifact;
				data.artifactBytes = proposal.artifactBytes;
				data.artifactFileName = proposal.artifactFileName;
				data.artifactMimeType = proposal.artifactMimeType;
				data.source = proposal.source;
				await this.saveTransaction(data, { mode: saveMode });
				resolve();
			};

			modal.onCancel = () => resolve();
			modal.open();
		});
	}

	private registerReportSyncListeners() {
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.expenseService.clearReportRenderCache();
				this.reportSyncService.scheduleAutoSync(`create:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.expenseService.clearReportRenderCache(file.path);
				this.reportSyncService.scheduleAutoSync(`modify:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.expenseService.clearReportRenderCache();
				this.reportSyncService.scheduleAutoSync(`delete:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (this.reportSyncService.shouldSyncForFile(file) || oldPath.startsWith(`${this.settings.expenseFolder}/`)) {
				this.expenseService.clearReportRenderCache();
				this.reportSyncService.scheduleAutoSync(`rename:${oldPath}`);
			}
		}));
	}

	async handleGenerateCustomReport() {
		const modal = new ReportPeriodModal(this.app, async (descriptor) => {
			try {
				const report = await this.reportSyncService.generateCustomReport(
					descriptor.startDate,
					descriptor.endDate,
				);
				new ReportsModal(this.app, report, this.expenseService).open();
			} catch (error) {
				new Notice(`Error generating report: ${(error as Error).message}`);
			}
		});
		modal.open();
	}

	async handleMigrateLegacyNotes() {
		try {
			const migrationService = new MigrationService(
				this.app,
				this.expenseService,
				this.reportSyncService,
			);
			const summary = await migrationService.migrateLegacyNotes();
			new Notice(
				[
					`Migrated transaction notes: ${summary.transactionNotesUpdated}`,
					`Migrated report notes: ${summary.reportNotesUpdated}`,
					`Renamed report notes: ${summary.reportNotesRenamed}`,
				].join(' | '),
				10000,
			);
		} catch (error) {
			new Notice(`Error during migration: ${(error as Error).message}`);
			this.logger.error('Migration failed', error);
		}
	}
}

/**
 * Plugin settings tab
 */
class ExpenseManagerSettingTab extends PluginSettingTab {
	plugin: ExpenseManagerPlugin;

	constructor(app: App, plugin: ExpenseManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Expense Manager Settings' });

		// Expense folder setting
		if (this.plugin.isParaCoreStorageManaged()) {
			new Setting(containerEl)
				.setName('Expense folder')
				.setDesc(`Storage is managed by PARA Core. Finance records are stored automatically in "${this.plugin.getManagedExpenseDirectory()}".`);
		} else {
			new Setting(containerEl)
				.setName('Expense folder')
				.setDesc('Where expense markdown files will be stored in standalone mode')
				.addText(text => text
					.setPlaceholder('Expenses')
					.setValue(this.plugin.settings.expenseFolder)
					.onChange(async (value) => {
						this.plugin.settings.expenseFolder = value;
						await this.plugin.saveSettings();
					}));
		}

		// Default currency
		new Setting(containerEl)
			.setName('Default currency')
			.setDesc('Currency code for transactions')
			.addText(text => text
				.setPlaceholder('RUB')
				.setValue(this.plugin.settings.defaultCurrency)
				.onChange(async (value) => {
					this.plugin.settings.defaultCurrency = value.toUpperCase();
					await this.plugin.saveSettings();
				}));

		// ProverkaCheka API key
		new Setting(containerEl)
			.setName('ProverkaCheka API key')
			.setDesc('API key for receipt lookup via ProverkaCheka (https://proverkacheka.com)')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.proverkaChekaApiKey)
				.onChange(async (value) => {
					this.plugin.settings.proverkaChekaApiKey = value;
					await this.plugin.saveSettings();
				}));

		// Auto-save receipt records
		new Setting(containerEl)
			.setName('Auto-save receipt records')
			.setDesc('Automatically save records created from receipt images without review')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSaveQrExpenses)
				.onChange(async (value) => {
					this.plugin.settings.autoSaveQrExpenses = value;
					await this.plugin.saveSettings();
				}));

		// Local-only receipt recognition
		new Setting(containerEl)
			.setName('Local receipt recognition only')
			.setDesc('Decode receipt QR data locally without sending requests to ProverkaCheka (works offline, but without item details)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.localQrOnly)
				.onChange(async (value) => {
					this.plugin.settings.localQrOnly = value;
					await this.plugin.saveSettings();
				}));

		// Confirmation notice
		new Setting(containerEl)
			.setName('Show confirmation notice')
			.setDesc('Display notification after saving transaction')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showConfirmationNotice)
				.onChange(async (value) => {
					this.plugin.settings.showConfirmationNotice = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'AI finance intake' });

		new Setting(containerEl)
			.setName('Enable AI finance text intake')
			.setDesc('Use an OpenAI-compatible endpoint for free-form `/finance_record` text extraction')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAiFinanceTextIntake)
				.onChange(async (value) => {
					this.plugin.settings.enableAiFinanceTextIntake = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('AI finance API base URL')
			.setDesc('Base URL for an OpenAI-compatible chat completions API')
			.addText(text => text
				.setPlaceholder('https://api.openai.com/v1')
				.setValue(this.plugin.settings.aiFinanceApiBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.aiFinanceApiBaseUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('AI finance API key')
			.setDesc('API key used for AI-backed finance text extraction')
			.addText(text => {
				text
					.setPlaceholder('Enter your API key')
					.setValue(this.plugin.settings.aiFinanceApiKey)
					.onChange(async (value) => {
						this.plugin.settings.aiFinanceApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('AI finance model')
			.setDesc('Model name for AI-backed finance text extraction')
			.addText(text => text
				.setPlaceholder('gpt-4.1-mini')
				.setValue(this.plugin.settings.aiFinanceModel)
				.onChange(async (value) => {
					this.plugin.settings.aiFinanceModel = value.trim();
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Email finance intake' });

		new Setting(containerEl)
			.setName('Enable email finance intake')
			.setDesc('Prepare delta-sync and coarse filtering for mailbox-based finance intake')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableEmailFinanceIntake)
				.onChange(async (value) => {
					this.plugin.settings.enableEmailFinanceIntake = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Email finance provider')
			.setDesc('Choose how finance emails are fetched for sync')
			.addDropdown(dropdown => dropdown
				.addOption('none', 'Not configured')
				.addOption('imap', 'IMAP (login + app password)')
				.addOption('http-json', 'HTTP JSON bridge')
				.setValue(this.plugin.settings.emailFinanceProvider)
				.onChange(async (value) => {
					if (value === 'none' || value === 'imap' || value === 'http-json') {
						this.plugin.settings.emailFinanceProvider = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Mailbox scope')
			.setDesc('Optional mailbox, folder, or label scope for the future mail provider')
			.addText(text => text
				.setPlaceholder('Receipts')
				.setValue(this.plugin.settings.emailFinanceMailboxScope)
				.onChange(async (value) => {
					this.plugin.settings.emailFinanceMailboxScope = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('IMAP host')
			.setDesc('Hostname of the IMAP server used with login and app password authentication')
			.addText(text => text
				.setPlaceholder('imap.gmail.com')
				.setValue(this.plugin.settings.emailFinanceImapHost)
				.onChange(async (value) => {
					this.plugin.settings.emailFinanceImapHost = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('IMAP port')
			.setDesc('Usually 993 for direct TLS IMAP')
			.addText(text => text
				.setPlaceholder('993')
				.setValue(String(this.plugin.settings.emailFinanceImapPort))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.plugin.settings.emailFinanceImapPort = Math.max(1, Math.round(parsed));
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('IMAP secure connection')
			.setDesc('Use direct TLS when connecting to the IMAP server')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.emailFinanceImapSecure)
				.onChange(async (value) => {
					this.plugin.settings.emailFinanceImapSecure = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('IMAP username')
			.setDesc('Email login used for IMAP authentication')
			.addText(text => text
				.setPlaceholder('you@example.com')
				.setValue(this.plugin.settings.emailFinanceImapUser)
				.onChange(async (value) => {
					this.plugin.settings.emailFinanceImapUser = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('IMAP app password')
			.setDesc('Application-specific password used instead of the normal account password')
			.addText(text => {
				text
					.setPlaceholder('Enter app password')
					.setValue(this.plugin.settings.emailFinanceImapPassword)
					.onChange(async (value) => {
						this.plugin.settings.emailFinanceImapPassword = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Email provider base URL')
			.setDesc('For the HTTP JSON bridge, messages are fetched from <base-url>/messages')
			.addText(text => text
				.setPlaceholder('https://mail-bridge.example.com')
				.setValue(this.plugin.settings.emailFinanceProviderBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.emailFinanceProviderBaseUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Email provider auth token')
			.setDesc('Bearer token used for the HTTP JSON bridge, when required')
			.addText(text => {
				text
					.setPlaceholder('Enter provider token')
					.setValue(this.plugin.settings.emailFinanceProviderAuthToken)
					.onChange(async (value) => {
						this.plugin.settings.emailFinanceProviderAuthToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Enable scheduled email sync')
			.setDesc('Run the same email sync pipeline automatically while Obsidian is open')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableScheduledEmailFinanceSync)
				.onChange(async (value) => {
					this.plugin.settings.enableScheduledEmailFinanceSync = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Email sync interval (minutes)')
			.setDesc('How often automatic email sync should run while Obsidian is open')
			.addText(text => text
				.setPlaceholder('15')
				.setValue(String(this.plugin.settings.emailFinanceSyncIntervalMinutes))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.plugin.settings.emailFinanceSyncIntervalMinutes = Math.max(1, Math.round(parsed));
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Max email messages per sync run')
			.setDesc('Limit how many emails are processed in one run to avoid overloading external APIs. The next run continues from the saved cursor.')
			.addText(text => text
				.setPlaceholder('20')
				.setValue(String(this.plugin.settings.emailFinanceMaxMessagesPerRun))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.plugin.settings.emailFinanceMaxMessagesPerRun = Math.max(1, Math.round(parsed));
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Telegram notifications for new email receipts')
			.setDesc('Send a Telegram message when email sync creates new pending-approval finance notes. Requires Telegram integration.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.sendTelegramEmailSyncNotifications)
				.onChange(async (value) => {
					this.plugin.settings.sendTelegramEmailSyncNotifications = value;
					await this.plugin.saveSettings();
				}));

		const filterRulesHint = containerEl.createEl('p', {
			text: 'Rule format: enabled|include|contains|any|receipt. Replace contains with regex for advanced patterns.',
		});
		filterRulesHint.addClass('setting-item-description');

		new Setting(containerEl)
			.setName('Email coarse filter rules')
			.setDesc('User-editable include/exclude rules used before deeper extraction')
			.addTextArea(text => text
				.setPlaceholder('enabled|include|contains|any|receipt')
				.setValue(formatEmailFinanceCoarseFilterRules(this.plugin.settings.emailFinanceCoarseFilterRules))
				.onChange(async (value) => {
					try {
						this.plugin.settings.emailFinanceCoarseFilterRules = parseEmailFinanceCoarseFilterRules(value);
						await this.plugin.saveSettings();
					} catch (error) {
						new Notice(`Email filter rules error: ${(error as Error).message}`);
					}
				}))
			.addButton(button => button
				.setButtonText('Reset defaults')
				.onClick(async () => {
					this.plugin.settings.emailFinanceCoarseFilterRules = createDefaultEmailFinanceCoarseFilterRules();
					await this.plugin.saveSettings();
					this.display();
				}));

		const syncState = this.plugin.settings.emailFinanceSyncState;
		const syncStatusText = syncState.lastSyncSummary
			? `${syncState.lastSyncStatus} | ${syncState.lastSyncSummary}`
			: syncState.lastSyncStatus;
		const syncCursorText = syncState.cursor ?? 'none';
		new Setting(containerEl)
			.setName('Email sync state')
			.setDesc(`Last attempt: ${syncState.lastAttemptAt ?? 'never'} | Last success: ${syncState.lastSuccessfulSyncAt ?? 'never'} | Cursor: ${syncCursorText} | Status: ${syncStatusText}`)
			.addButton(button => button
				.setButtonText('Reset boundary')
				.onClick(async () => {
					await this.plugin.persistEmailFinanceSyncState(createDefaultEmailFinanceSyncState());
					new Notice('Email finance sync boundary reset.');
					this.display();
				}))
			.addButton(button => button
				.setButtonText('Run sync')
				.onClick(async () => {
					await this.plugin.handleSyncFinanceEmails();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Shared runtime log')
			.setDesc('Uses the PARA Core shared runtime log. The file is created only after the first warning or error and can be configured in PARA Core settings.')
			.addButton(button => button
				.setButtonText('Open')
				.onClick(async () => {
					await this.plugin.openDebugLog();
				}));

		containerEl.createEl('h3', { text: 'Reports' });

		new Setting(containerEl)
			.setName('Auto-sync reports on vault changes')
			.setDesc('Rebuild finance reports automatically after transaction notes change')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncReportsOnVaultChanges)
				.onChange(async (value) => {
					this.plugin.settings.autoSyncReportsOnVaultChanges = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic monthly reports')
			.setDesc('Keep monthly finance reports updated with cumulative balance')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoMonthlyReports)
				.onChange(async (value) => {
					this.plugin.settings.autoMonthlyReports = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic quarterly reports')
			.setDesc('Keep quarterly finance reports updated')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoQuarterlyReports)
				.onChange(async (value) => {
					this.plugin.settings.autoQuarterlyReports = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic half-year reports')
			.setDesc('Keep half-year finance reports updated')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoHalfYearReports)
				.onChange(async (value) => {
					this.plugin.settings.autoHalfYearReports = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic yearly reports')
			.setDesc('Keep yearly finance reports updated')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoYearlyReports)
				.onChange(async (value) => {
					this.plugin.settings.autoYearlyReports = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Budget alerts' });

		new Setting(containerEl)
			.setName('Enable budget alerts')
			.setDesc('Show warning, forecast, and critical budget state inside finance reports')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableBudgetAlerts)
				.onChange(async (value) => {
					this.plugin.settings.enableBudgetAlerts = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Budget warning threshold')
			.setDesc('Mark report as warning when spending reaches this percent of the budget')
			.addText(text => text
				.setPlaceholder('80')
				.setValue(String(this.plugin.settings.budgetAlertWarningThresholdPercent))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.plugin.settings.budgetAlertWarningThresholdPercent = Math.min(100, Math.max(1, parsed));
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Enable budget forecast alerts')
			.setDesc('Estimate month-end overspend for the current month and show forecast alerts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableBudgetForecastAlerts)
				.onChange(async (value) => {
					this.plugin.settings.enableBudgetForecastAlerts = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Forecast alerts start day')
			.setDesc('Do not show forecast alerts before this day of the month')
			.addText(text => text
				.setPlaceholder('5')
				.setValue(String(this.plugin.settings.budgetForecastStartDay))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.plugin.settings.budgetForecastStartDay = Math.max(1, Math.min(31, Math.round(parsed)));
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Dashboard contribution mode')
			.setDesc('Choose between a lighter dashboard and the full interactive finance dashboard')
			.addDropdown(dropdown => dropdown
				.addOption('simple', 'Simple')
				.addOption('interactive', 'Interactive')
				.setValue(this.plugin.settings.dashboardContributionMode)
				.onChange(async (value) => {
					if (value === 'simple' || value === 'interactive') {
						this.plugin.settings.dashboardContributionMode = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Proactive Telegram budget alerts')
			.setDesc('Send Telegram notifications for current-month budget crossing events: warning, forecast, critical')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.sendProactiveTelegramBudgetAlerts)
				.onChange(async (value) => {
					this.plugin.settings.sendProactiveTelegramBudgetAlerts = value;
					await this.plugin.saveSettings();
				}));

		// Telegram integration
		new Setting(containerEl)
			.setName('Enable Telegram integration')
			.setDesc('Allow finance record entry via Telegram bot (requires Telegram Bot plugin)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTelegramIntegration)
				.onChange(async (value) => {
					this.plugin.settings.enableTelegramIntegration = value;
					await this.plugin.saveSettings();
					// Reload plugin to apply changes
					location.reload();
				}));

		// Categories management
		containerEl.createEl('h3', { text: 'Categories' });

		new Setting(containerEl)
			.setName('Expense categories')
			.setDesc('Comma-separated list of expense categories')
			.addTextArea(text => text
				.setPlaceholder('Food, Transport, Shopping...')
				.setValue(this.plugin.settings.expenseCategories.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.expenseCategories = value
						.split(',')
						.map(c => c.trim())
						.filter(c => c.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Income categories')
			.setDesc('Comma-separated list of income categories')
			.addTextArea(text => text
				.setPlaceholder('Salary, Freelance, Investments...')
				.setValue(this.plugin.settings.incomeCategories.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.incomeCategories = value
						.split(',')
						.map(c => c.trim())
						.filter(c => c.length > 0);
					await this.plugin.saveSettings();
				}));
	}
}
