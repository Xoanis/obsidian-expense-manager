import { TransactionType } from './types';

export type DashboardContributionMode = 'simple' | 'interactive';

/**
 * Plugin settings interface
 */
export interface ExpenseManagerSettings {
	/** Folder path where expense files are stored */
	expenseFolder: string;
	
	/** Default currency code */
	defaultCurrency: string;
	
	/** ProverkaCheka API key for QR receipt processing */
	proverkaChekaApiKey: string;
	
	/** Whether to auto-save after QR processing (vs showing review modal) */
	autoSaveQrExpenses: boolean;
	
	/** Use only local QR recognition without sending to ProverkaCheka API */
	localQrOnly: boolean;
	
	/** Predefined categories for expenses */
	expenseCategories: string[];
	
	/** Predefined categories for income */
	incomeCategories: string[];
	
	/** Default transaction type when opening quick add */
	defaultTransactionType: TransactionType;
	
	/** Date format for display (e.g., 'YYYY-MM-DD HH:mm') */
	dateFormat: string;
	
	/** Enable Telegram bot integration */
	enableTelegramIntegration: boolean;
	
	/** Show confirmation notice after saving transaction */
	showConfirmationNotice: boolean;

	/** Keep monthly reports updated automatically */
	autoMonthlyReports: boolean;

	/** Keep quarterly reports updated automatically */
	autoQuarterlyReports: boolean;

	/** Keep half-year reports updated automatically */
	autoHalfYearReports: boolean;

	/** Keep yearly reports updated automatically */
	autoYearlyReports: boolean;

	/** Rebuild reports automatically after relevant vault changes */
	autoSyncReportsOnVaultChanges: boolean;

	/** Show and compute budget alerts in reports */
	enableBudgetAlerts: boolean;

	/** Warning threshold for budget usage percentage */
	budgetAlertWarningThresholdPercent: number;

	/** Enable forecast-based budget alerts for current monthly report */
	enableBudgetForecastAlerts: boolean;

	/** Start forecast alerts after this calendar day of month */
	budgetForecastStartDay: number;

	/** Dashboard contribution complexity mode */
	dashboardContributionMode: DashboardContributionMode;

	/** Send proactive Telegram budget alerts for current monthly report */
	sendProactiveTelegramBudgetAlerts: boolean;

	/** Enable AI-backed finance text intake for free-form inputs */
	enableAiFinanceTextIntake: boolean;

	/** Base URL for an OpenAI-compatible chat completions endpoint */
	aiFinanceApiBaseUrl: string;

	/** API key for the AI finance endpoint */
	aiFinanceApiKey: string;

	/** Model name for AI-backed finance text extraction */
	aiFinanceModel: string;

	/** Mirror selected runtime logs into a markdown file inside the vault */
	enableDebugFileLogging: boolean;

	/** Vault-relative path for the debug log markdown file */
	debugLogFilePath: string;
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: ExpenseManagerSettings = {
	expenseFolder: 'Expenses',
	defaultCurrency: 'RUB',
	proverkaChekaApiKey: '',
	autoSaveQrExpenses: false,
	localQrOnly: false,
	expenseCategories: [
		'Food',
		'Transport',
		'Shopping',
		'Entertainment',
		'Bills',
		'Healthcare',
		'Education',
		'Other'
	],
	incomeCategories: [
		'Salary',
		'Freelance',
		'Investments',
		'Gifts',
		'Other'
	],
	defaultTransactionType: 'expense',
	dateFormat: 'YYYY-MM-DD HH:mm',
	enableTelegramIntegration: true,
	showConfirmationNotice: true,
	autoMonthlyReports: true,
	autoQuarterlyReports: false,
	autoHalfYearReports: false,
	autoYearlyReports: true,
	autoSyncReportsOnVaultChanges: true,
	enableBudgetAlerts: true,
	budgetAlertWarningThresholdPercent: 80,
	enableBudgetForecastAlerts: true,
	budgetForecastStartDay: 5,
	dashboardContributionMode: 'interactive',
	sendProactiveTelegramBudgetAlerts: false,
	enableAiFinanceTextIntake: false,
	aiFinanceApiBaseUrl: 'https://api.openai.com/v1',
	aiFinanceApiKey: '',
	aiFinanceModel: 'gpt-4.1-mini',
	enableDebugFileLogging: true,
	debugLogFilePath: 'ExpenseManager/debug-log.md',
};
