import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { ExpenseManagerSettings, DEFAULT_SETTINGS } from './src/settings';
import { ExpenseService } from './src/services/expense-service';
import { AnalyticsService } from './src/services/analytics-service';
import { ManualHandler } from './src/handlers/manual-handler';
import { QrHandler } from './src/handlers/qr-handler';
import { TelegramHandler } from './src/handlers/telegram-handler';
import { TransactionData } from './src/types';
import { registerAddExpenseCommand } from './src/commands/add-expense';
import { registerAddIncomeCommand } from './src/commands/add-income';
import { registerAddQrExpenseCommand } from './src/commands/add-qr-expense';
import { registerGenerateReportCommand } from './src/commands/generate-report';
import { ReportsModal } from './src/ui/reports-modal';
import { ITelegramBotPluginAPIv1 } from './telegram_plugin_api';

// Try to import Telegram API (may not be available)
let TelegramApiClass: any = null;
try {
	TelegramApiClass = require('./telegram_plugin_api');
} catch (e) {
	console.log('Telegram plugin API not available');
}

export default class ExpenseManagerPlugin extends Plugin {
	settings: ExpenseManagerSettings;
	
	private expenseService!: ExpenseService;
	private analyticsService!: AnalyticsService;
	private telegramHandler!: TelegramHandler;
	private telegramApi: ITelegramBotPluginAPIv1 | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize services
		this.expenseService = new ExpenseService(this.app, this.settings.expenseFolder);
		this.analyticsService = new AnalyticsService(this.expenseService);

		// Initialize Telegram handler if API is available
		await this.initializeTelegramIntegration();

		// Register commands
		registerAddExpenseCommand(this);
		registerAddIncomeCommand(this);
		registerAddQrExpenseCommand(this);
		registerGenerateReportCommand(this);

		// Add ribbon icon
		this.addRibbonIcon('wallet', 'Add Expense', () => {
			this.handleAddExpense();
		});

		// Add settings tab
		this.addSettingTab(new ExpenseManagerSettingTab(this.app, this));

		// Show startup notice
		new Notice('Expense Manager loaded');
	}

	onunload() {
		// Cleanup
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		
		// Reinitialize services with new settings
		this.expenseService = new ExpenseService(this.app, this.settings.expenseFolder);
	}

	/**
	 * Command handlers
	 */
	async handleAddExpense() {
		const handler = new ManualHandler(
			this.app,
			this.settings.defaultTransactionType,
			this.settings.defaultCurrency,
			this.settings.expenseCategories
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
			'income',
			this.settings.defaultCurrency,
			this.settings.incomeCategories
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
			this.settings.proverkaChekaApiKey,
			this.settings.autoSaveQrExpenses
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
			const report = await this.analyticsService.generateCurrentMonthReport();
			const modal = new ReportsModal(this.app, report);
			modal.open();
		} catch (error) {
			new Notice(`Error generating report: ${(error as Error).message}`);
		}
	}

	/**
	 * Save transaction to vault
	 */
	private async saveTransaction(data: TransactionData) {
		try {
			const file = await this.expenseService.createTransaction(data);
			
			if (this.settings.showConfirmationNotice) {
				const emoji = data.type === 'expense' ? '💸' : '💰';
				new Notice(`${emoji} Saved: ${data.amount.toFixed(2)} ${data.currency} - ${data.comment}`);
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

		// Try to get Telegram API from other plugin
		try {
			// @ts-ignore - Telegram plugin may not exist
			const telegramPlugin = this.app.plugins?.plugins?.['telegram-bot'];
			if (telegramPlugin && telegramPlugin.getApi) {
				this.telegramApi = telegramPlugin.getApi();
				
				if (this.telegramApi) {
					this.telegramHandler = new TelegramHandler(
						this.app,
						this.expenseService,
						this.telegramApi
					);
					
					await this.telegramHandler.initialize();
					console.log('Telegram integration initialized');
				}
			}
		} catch (error) {
			console.log('Telegram integration not available:', error);
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
