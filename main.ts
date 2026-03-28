import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { ExpenseManagerSettings, DEFAULT_SETTINGS } from './src/settings';
import { ExpenseService } from './src/services/expense-service';
import { AnalyticsService } from './src/services/analytics-service';
import { ManualHandler } from './src/handlers/manual-handler';
import { QrHandler } from './src/handlers/qr-handler';
import { TransactionData } from './src/types';
import { registerAddExpenseCommand } from './src/commands/add-expense';
import { registerAddIncomeCommand } from './src/commands/add-income';
import { registerAddQrExpenseCommand } from './src/commands/add-qr-expense';
import { registerGenerateReportCommand } from './src/commands/generate-report';
import { registerGenerateReportFileCommand } from './src/commands/generate-report-file';
import { registerGenerateCustomReportCommand } from './src/commands/generate-custom-report';
import { registerMigrateLegacyNotesCommand } from './src/commands/migrate-legacy-notes';
import { getParaCoreApi } from './src/integrations/para-core/para-core-client';
import { registerFinanceDomain } from './src/integrations/para-core/register-finance-domain';
import { registerFinanceMetadataContributions } from './src/integrations/para-core/register-metadata-contributions';
import { registerFinanceTemplateContributions } from './src/integrations/para-core/register-template-contributions';
import { registerFinanceTelegramHelpContributions } from './src/integrations/para-core/register-telegram-help-contributions';
import { IParaCoreApi, RegisteredParaDomain } from './src/integrations/para-core/types';
import { FinanceTelegramBridge } from './src/integrations/telegram/finance-telegram-bridge';
import { getTelegramBotApi, TelegramBotApi } from './src/integrations/telegram/client';
import { ReportSyncService } from './src/services/report-sync-service';
import { TelegramChartService } from './src/services/telegram-chart-service';
import { TelegramBudgetAlertService } from './src/services/telegram-budget-alert-service';
import { MigrationService } from './src/services/migration-service';
import { FinanceIntakeService } from './src/services/finance-intake-service';
import { ReportPeriodModal } from './src/ui/report-period-modal';
import { ReportsModal } from './src/ui/reports-modal';
import { PLUGIN_UNIT_NAME } from './src/utils/constants';
import { VaultDebugFileLogger } from './src/utils/plugin-debug-log';

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
	private financeIntakeService!: FinanceIntakeService;
	private debugLogger!: VaultDebugFileLogger;

	async onload() {
		await this.loadSettings();
		this.debugLogger = new VaultDebugFileLogger(this.app, () => this.settings);

		// Initialize PARA Core integration if available
		this.initializeParaCoreIntegration();

		// Initialize services
		this.expenseService = new ExpenseService(this.app, this.settings, this.paraCoreApi, this.financeDomain);
		this.analyticsService = new AnalyticsService(this.expenseService);
		this.telegramBudgetAlertService = new TelegramBudgetAlertService(this.app, this.settings);
		this.reportSyncService = new ReportSyncService(
			this.app,
			this.expenseService,
			this.settings,
			this.telegramBudgetAlertService,
		);
		this.telegramChartService = new TelegramChartService(this.reportSyncService);
		this.financeIntakeService = new FinanceIntakeService(this.settings, {
			logger: this.debugLogger,
		});
		this.registerParaCoreTelegramCardContributions();

		// Initialize Telegram handler if API is available
		await this.initializeTelegramIntegration();

		// Register commands
		registerAddExpenseCommand(this);
		registerAddIncomeCommand(this);
		registerAddQrExpenseCommand(this);
		registerGenerateReportCommand(this);
		registerGenerateReportFileCommand(this);
		registerGenerateCustomReportCommand(this);
		registerMigrateLegacyNotesCommand(this);
		this.addCommand({
			id: 'open-debug-log',
			name: 'Open debug log',
			callback: async () => {
				await this.openDebugLog();
			},
		});

		// Add ribbon icon
		this.addRibbonIcon('wallet', 'Add Expense', () => {
			this.handleAddExpense();
		});

		// Add settings tab
		this.addSettingTab(new ExpenseManagerSettingTab(this.app, this));
		this.registerReportSyncListeners();
		await this.reportSyncService.initialize();

		// Show startup notice
		new Notice('Expense Manager loaded');
	}

	onunload() {
		console.log('Unloading plugin Expense Manager')
		this.reportSyncService?.destroy();
		this.telegramApi?.disposeHandlersForUnit(PLUGIN_UNIT_NAME);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeParaCoreIntegration();
		this.expenseService = new ExpenseService(
			this.app,
			this.settings,
			this.paraCoreApi,
			this.financeDomain,
		);
		this.analyticsService = new AnalyticsService(this.expenseService);
		this.reportSyncService?.destroy();
		this.telegramBudgetAlertService = new TelegramBudgetAlertService(this.app, this.settings);
		this.reportSyncService = new ReportSyncService(
			this.app,
			this.expenseService,
			this.settings,
			this.telegramBudgetAlertService,
		);
		this.telegramChartService = new TelegramChartService(this.reportSyncService);
		this.financeIntakeService = new FinanceIntakeService(this.settings, {
			logger: this.debugLogger,
		});
		this.registerParaCoreTelegramCardContributions();
		this.telegramApi?.disposeHandlersForUnit(PLUGIN_UNIT_NAME);
		await this.initializeTelegramIntegration();
		await this.reportSyncService.initialize();
	}

	async openDebugLog() {
		const file = await this.debugLogger.ensureLogFileExists();
		if (!file) {
			new Notice('Unable to create debug log file.');
			return;
		}

		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/**
	 * Register template contributions in PARA Core when available.
	 * The plugin still works in standalone mode if PARA Core is not installed.
	 */
	private initializeParaCoreIntegration() {
		this.paraCoreApi = getParaCoreApi(this.app);
		this.financeDomain = null;
		if (!this.paraCoreApi) {
			console.log('Expense Manager: PARA Core integration not available');
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
		console.log('Expense Manager: registered PARA Core template contributions');
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
	async handleAddExpense() {
		const handler = new ManualHandler(
			this.app,
			this.settings,
			'expense'
		);

		const result = await handler.handle();
		
		if (result.success && result.data) {
			await this.saveTransaction(result.data);
		} else if (result.error) {
			new Notice(result.error);
		}
	}

	async handleAddIncome() {
		const handler = new ManualHandler(
			this.app,
			this.settings,
			'income'
		);

		const result = await handler.handle();
		
		if (result.success && result.data) {
			await this.saveTransaction(result.data);
		} else if (result.error) {
			new Notice(result.error);
		}
	}

	async handleAddQrExpense() {
		const handler = new QrHandler(
			this.app,
			this.settings
		);

		const result = await handler.handle();
		
		if (result.success && result.data) {
			await this.saveTransaction(result.data);
		} else if (result.error) {
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
			console.error('Save error:', error);
		}
	}

	/**
	 * Save transaction to vault
	 */
	private async saveTransaction(data: TransactionData) {
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
				console.log('Duplicate transaction prevented:', data.description);
				return;
			}
			
			const file = await this.expenseService.createTransaction(data);
			this.reportSyncService.scheduleAutoSync(`transaction-saved:${file.path}`);
			
			if (this.settings.showConfirmationNotice) {
				const emoji = data.type === 'expense' ? '💸' : '💰';
				new Notice(`${emoji} Saved: ${data.amount.toFixed(2)} ${data.currency} - ${data.description}`);
			}
		} catch (error) {
			new Notice(`Error saving transaction: ${(error as Error).message}`);
			console.error('Save error:', error);
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
				console.log('Telegram integration failed: API is unavailable');
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
				console.log('Telegram integration failed: unable to register Telegram bridge');
				return;
			}

			this.registerParaCoreMetadataContributions();
			this.registerParaCoreTelegramCardContributions();
			this.registerParaCoreTelegramHelpContributions();
			console.log('Telegram integration initialized');
		} catch (error) {
			console.log('Telegram integration not available:', error);
		}
	}

	private registerReportSyncListeners() {
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.reportSyncService.scheduleAutoSync(`create:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.reportSyncService.scheduleAutoSync(`modify:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (this.reportSyncService.shouldSyncForFile(file)) {
				this.reportSyncService.scheduleAutoSync(`delete:${file.path}`);
			}
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (this.reportSyncService.shouldSyncForFile(file) || oldPath.startsWith(`${this.settings.expenseFolder}/`)) {
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
			console.error('Migration error:', error);
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
		new Setting(containerEl)
			.setName('Expense folder')
			.setDesc('Where expense markdown files will be stored')
			.addText(text => text
				.setPlaceholder('Expenses')
				.setValue(this.plugin.settings.expenseFolder)
				.onChange(async (value) => {
					this.plugin.settings.expenseFolder = value;
					await this.plugin.saveSettings();
				}));

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
			.setDesc('API key for receipt QR code processing (https://proverkacheka.com)')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.proverkaChekaApiKey)
				.onChange(async (value) => {
					this.plugin.settings.proverkaChekaApiKey = value;
					await this.plugin.saveSettings();
				}));

		// Auto-save QR expenses
		new Setting(containerEl)
			.setName('Auto-save QR expenses')
			.setDesc('Automatically save expenses after QR processing without review')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSaveQrExpenses)
				.onChange(async (value) => {
					this.plugin.settings.autoSaveQrExpenses = value;
					await this.plugin.saveSettings();
				}));

		// Local-only QR recognition
		new Setting(containerEl)
			.setName('Local QR recognition only')
			.setDesc('Use only local QR decoding without sending to ProverkaCheka API (no item details, but works offline)')
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

		new Setting(containerEl)
			.setName('Write debug log to file')
			.setDesc('Mirror AI finance intake logs into a markdown file inside the vault for easier debugging')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugFileLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugFileLogging = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug log path')
			.setDesc('Vault-relative markdown file used for expense-manager debug logs')
			.addText(text => text
				.setPlaceholder('ExpenseManager/debug-log.md')
				.setValue(this.plugin.settings.debugLogFilePath)
				.onChange(async (value) => {
					this.plugin.settings.debugLogFilePath = value.trim() || 'ExpenseManager/debug-log.md';
					await this.plugin.saveSettings();
				}))
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
			.setDesc('Allow expense/income entry via Telegram bot (requires Telegram Bot plugin)')
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
