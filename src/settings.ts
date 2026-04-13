import { TransactionType } from './types';

export type DashboardContributionMode = 'simple' | 'interactive';
export type EmailFinanceProviderKind = 'none' | 'email-provider';
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

	/** Archive rejected finance review notes instead of deleting them immediately */
	archiveRejectedTransactions: boolean;

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

	/** Send Telegram notifications when email sync creates new pending-approval notes */
	sendTelegramEmailSyncNotifications: boolean;

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

	/** Optional email-provider channel selection: one id or a comma/newline-separated list */
	emailFinanceProviderChannelId: string;

	/** Enable scheduled email finance sync */
	enableScheduledEmailFinanceSync: boolean;

	/** Interval for scheduled email sync, in minutes */
	emailFinanceSyncIntervalMinutes: number;

	/** Maximum number of email messages processed in one sync run */
	emailFinanceMaxMessagesPerRun: number;

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
	archiveRejectedTransactions: true,
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
	sendTelegramEmailSyncNotifications: false,
	enableAiFinanceTextIntake: false,
	aiFinanceApiBaseUrl: 'https://api.openai.com/v1',
	aiFinanceApiKey: '',
	aiFinanceModel: 'gpt-4.1-mini',
	enableEmailFinanceIntake: false,
	emailFinanceProvider: 'none',
	emailFinanceProviderChannelId: '',
	enableScheduledEmailFinanceSync: false,
	emailFinanceSyncIntervalMinutes: 15,
	emailFinanceMaxMessagesPerRun: 20,
	emailFinanceCoarseFilterRules: createDefaultEmailFinanceCoarseFilterRules(),
	emailFinanceSyncState: createDefaultEmailFinanceSyncState(),
};

export interface ExpenseManagerSettingsNormalizationResult {
	settings: ExpenseManagerSettings;
	normalizedLegacyEmailFinanceProvider: 'imap' | 'http-json' | null;
	removedLegacyEmailFinanceConfigKeys: string[];
}

export function normalizeExpenseManagerSettings(raw: unknown): ExpenseManagerSettingsNormalizationResult {
	const source = isRecord(raw) ? raw : {};
	const loaded = Object.assign({}, DEFAULT_SETTINGS, source) as ExpenseManagerSettings;
	const normalizedProvider = normalizeEmailFinanceProviderKind(source.emailFinanceProvider);
	const removedLegacyEmailFinanceConfigKeys = collectRemovedLegacyEmailFinanceConfigKeys(source);

	return {
		settings: {
			...loaded,
			emailFinanceProvider: normalizedProvider.kind,
			emailFinanceProviderChannelId: typeof loaded.emailFinanceProviderChannelId === 'string'
				? loaded.emailFinanceProviderChannelId
				: DEFAULT_SETTINGS.emailFinanceProviderChannelId,
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
		},
		normalizedLegacyEmailFinanceProvider: normalizedProvider.normalizedLegacyProvider,
		removedLegacyEmailFinanceConfigKeys,
	};
}

function normalizeEmailFinanceProviderKind(value: unknown): {
	kind: EmailFinanceProviderKind;
	normalizedLegacyProvider: 'imap' | 'http-json' | null;
} {
	if (value === 'email-provider') {
		return {
			kind: 'email-provider',
			normalizedLegacyProvider: null,
		};
	}

	if (value === 'imap' || value === 'http-json') {
		return {
			kind: 'email-provider',
			normalizedLegacyProvider: value,
		};
	}

	return {
		kind: 'none',
		normalizedLegacyProvider: null,
	};
}

function collectRemovedLegacyEmailFinanceConfigKeys(source: Record<string, unknown>): string[] {
	const legacyKeys = [
		'emailFinanceMailboxScope',
		'emailFinanceImapHost',
		'emailFinanceImapPort',
		'emailFinanceImapSecure',
		'emailFinanceImapUser',
		'emailFinanceImapPassword',
		'emailFinanceProviderBaseUrl',
		'emailFinanceProviderAuthToken',
	];

	return legacyKeys.filter((key) => key in source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object';
}
