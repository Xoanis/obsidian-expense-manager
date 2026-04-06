import { TransactionType } from './types';

export type DashboardContributionMode = 'simple' | 'interactive';
export type EmailFinanceProviderKind = 'none' | 'imap' | 'http-json';
export type EmailFinanceCoarseFilterField = 'from' | 'subject' | 'body' | 'attachmentName' | 'any';
export type EmailFinanceCoarseFilterMode = 'contains' | 'regex';
export type EmailFinanceCoarseFilterAction = 'include' | 'exclude';

export interface EmailFinanceCoarseFilterRule {
	id: string;
	enabled: boolean;
	field: EmailFinanceCoarseFilterField;
	mode: EmailFinanceCoarseFilterMode;
	pattern: string;
	action: EmailFinanceCoarseFilterAction;
}

export interface EmailFinanceSyncState {
	lastSuccessfulSyncAt: string | null;
	cursor: string | null;
	lastAttemptAt: string | null;
	lastSyncStatus: 'idle' | 'success' | 'failed' | 'skipped';
	lastSyncSummary: string | null;
}

export function createDefaultEmailFinanceCoarseFilterRules(): EmailFinanceCoarseFilterRule[] {
	return [
		{ id: 'email-include-receipt', enabled: true, field: 'any', mode: 'contains', pattern: 'receipt', action: 'include' },
		{ id: 'email-include-invoice', enabled: true, field: 'any', mode: 'contains', pattern: 'invoice', action: 'include' },
		{ id: 'email-include-payment', enabled: true, field: 'any', mode: 'contains', pattern: 'payment', action: 'include' },
		{ id: 'email-include-чек', enabled: true, field: 'any', mode: 'contains', pattern: 'чек', action: 'include' },
	];
}

export function createDefaultEmailFinanceSyncState(): EmailFinanceSyncState {
	return {
		lastSuccessfulSyncAt: null,
		cursor: null,
		lastAttemptAt: null,
		lastSyncStatus: 'idle',
		lastSyncSummary: null,
	};
}

export function formatEmailFinanceCoarseFilterRules(rules: EmailFinanceCoarseFilterRule[]): string {
	return rules.map((rule) => [
		rule.enabled ? 'enabled' : 'disabled',
		rule.action,
		rule.mode,
		rule.field,
		rule.pattern,
	].join('|')).join('\n');
}

export function parseEmailFinanceCoarseFilterRules(value: string): EmailFinanceCoarseFilterRule[] {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'));

	return lines.map((line, index) => {
		const [rawEnabled, rawAction, rawMode, rawField, ...patternParts] = line.split('|');
		const pattern = patternParts.join('|').trim();
		if (!pattern) {
			throw new Error(`Rule ${index + 1}: missing pattern`);
		}

		if (rawEnabled !== 'enabled' && rawEnabled !== 'disabled') {
			throw new Error(`Rule ${index + 1}: first token must be "enabled" or "disabled"`);
		}
		if (rawAction !== 'include' && rawAction !== 'exclude') {
			throw new Error(`Rule ${index + 1}: action must be "include" or "exclude"`);
		}
		if (rawMode !== 'contains' && rawMode !== 'regex') {
			throw new Error(`Rule ${index + 1}: mode must be "contains" or "regex"`);
		}
		if (rawField !== 'from' && rawField !== 'subject' && rawField !== 'body' && rawField !== 'attachmentName' && rawField !== 'any') {
			throw new Error(`Rule ${index + 1}: field must be from|subject|body|attachmentName|any`);
		}

		return {
			id: `email-rule-${index + 1}-${rawField}-${rawAction}`,
			enabled: rawEnabled === 'enabled',
			action: rawAction,
			mode: rawMode,
			field: rawField,
			pattern,
		};
	});
}

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

	/** Enable email-based finance intake scaffolding */
	enableEmailFinanceIntake: boolean;

	/** Mail provider kind used for finance sync */
	emailFinanceProvider: EmailFinanceProviderKind;

	/** Optional mailbox or folder scope */
	emailFinanceMailboxScope: string;

	/** IMAP server host */
	emailFinanceImapHost: string;

	/** IMAP server port */
	emailFinanceImapPort: number;

	/** Use direct TLS for IMAP */
	emailFinanceImapSecure: boolean;

	/** IMAP username */
	emailFinanceImapUser: string;

	/** IMAP password or app password */
	emailFinanceImapPassword: string;

	/** Base URL for a provider-compatible mail JSON endpoint */
	emailFinanceProviderBaseUrl: string;

	/** Auth token for the provider-compatible mail JSON endpoint */
	emailFinanceProviderAuthToken: string;

	/** Enable scheduled email finance sync */
	enableScheduledEmailFinanceSync: boolean;

	/** Interval for scheduled email sync, in minutes */
	emailFinanceSyncIntervalMinutes: number;

	/** User-editable coarse filter rules */
	emailFinanceCoarseFilterRules: EmailFinanceCoarseFilterRule[];

	/** Persisted delta-sync state */
	emailFinanceSyncState: EmailFinanceSyncState;
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
	enableEmailFinanceIntake: false,
	emailFinanceProvider: 'none',
	emailFinanceMailboxScope: '',
	emailFinanceImapHost: '',
	emailFinanceImapPort: 993,
	emailFinanceImapSecure: true,
	emailFinanceImapUser: '',
	emailFinanceImapPassword: '',
	emailFinanceProviderBaseUrl: '',
	emailFinanceProviderAuthToken: '',
	enableScheduledEmailFinanceSync: false,
	emailFinanceSyncIntervalMinutes: 15,
	emailFinanceCoarseFilterRules: createDefaultEmailFinanceCoarseFilterRules(),
	emailFinanceSyncState: createDefaultEmailFinanceSyncState(),
};
