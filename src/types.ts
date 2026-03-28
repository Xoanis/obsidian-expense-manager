import { TFile } from 'obsidian';

/**
 * Type of financial transaction
 */
export type TransactionType = 'expense' | 'income';

/**
 * Core interface for expense/income data
 */
export interface TransactionData {
	/** Unique identifier (generated from file path) */
	id?: string;
	
	/** Transaction type: expense or income */
	type: TransactionType;
	
	/** Amount of money */
	amount: number;
	
	/** Currency code (e.g., RUB, USD, EUR) */
	currency: string;
	
	/** Date and time of transaction (ISO format) */
	dateTime: string;
	
	/** Short human-readable description */
	description: string;

	/** Legacy alias kept for backward compatibility while reading old notes */
	comment?: string;

	/** Linked PARA area for semantic context, e.g. [[Health]] */
	area?: string;

	/** Linked PARA project when transaction belongs to a project */
	project?: string;
	
	/** Tags/categories for the transaction */
	tags: string[];
	
	/** Primary category (derived from tags or predefined) */
	category?: string;
	
	/** Additional details (e.g., items from receipt) */
	details?: TransactionDetail[];

	/** Linked artifact such as a receipt image */
	artifact?: string;

	/** Transient artifact payload before note creation */
	artifactBytes?: ArrayBuffer;
	artifactFileName?: string;
	artifactMimeType?: string;
	
	/** Source of the transaction (manual, qr, telegram, pdf, etc.) */
	source: TransactionSource;
	
	/** Fiscal document number (Фискальный номер документа) */
	fd?: string;
	
	/** Fiscal drive number (Фискальный номер накопителя) */
	fn?: string;
	
	/** Fiscal sign (Фискальный признак) */
	fp?: string;
	
	/** Reference to the markdown file */
	file?: TFile;
}

/**
 * Line item detail from a receipt
 */
export interface TransactionDetail {
	name: string;
	quantity: number;
	price: number;
	total: number;
}

/**
 * Source of transaction data
 */
export type TransactionSource = 
	| 'manual'           // Manual entry via modal
	| 'qr'              // QR code from receipt
	| 'telegram'        // Telegram bot
	| 'pdf'             // PDF bank statement (future)
	| 'api';            // External API integration

/**
 * Result of handler operations
 */
export interface HandlerResult {
	/** Whether the operation was successful */
	success: boolean;
	
	/** Transaction data if successful */
	data?: TransactionData;
	
	/** Error message if failed */
	error?: string;
}

/**
 * Period report for analytics
 */
export interface PeriodReport {
	/** Period type */
	periodKind: ReportPeriodKind;

	/** Stable key for report note upsert */
	periodKey: string;

	/** Human-readable period label */
	periodLabel: string;

	/** Start date of period */
	startDate: Date;
	
	/** End date of period */
	endDate: Date;
	
	/** Total expenses */
	totalExpenses: number;
	
	/** Total income */
	totalIncome: number;

	/** Net period change (income - expenses) */
	netChange: number;

	/** Balance at the start of period */
	openingBalance: number;

	/** Closing balance at the end of period */
	closingBalance: number;

	/** Backward-compatible alias for closing balance */
	balance: number;

	/** Optional budget summary for this report */
	budget: ReportBudgetSummary | null;

	/** Transactions in this period */
	transactions: TransactionData[];

	/** Combined category breakdown */
	byCategory: CategorySummary[];

	/** Expense-only category breakdown */
	expenseByCategory: CategorySummary[];

	/** Income-only category breakdown */
	incomeByCategory: CategorySummary[];
}

/**
 * Summary by category
 */
export interface CategorySummary {
	/** Category name */
	category: string;
	
	/** Total amount */
	total: number;
	
	/** Percentage of total */
	percentage: number;
	
	/** Count of transactions */
	count: number;
}

/**
 * Chart data for visualization
 */
export interface ChartData {
	/** Labels for chart */
	labels: string[];
	
	/** Data values */
	values: number[];
	
	/** Colors for each segment */
	colors?: string[];
}

export interface FinanceContextSummary {
	totalExpenses: number;
	totalIncome: number;
	balance: number;
	transactionCount: number;
	linkedProjectCount: number;
	recentTransactions: TransactionData[];
}

export type ReportPeriodKind = 'custom' | 'month' | 'quarter' | 'half-year' | 'year';

export interface ReportPeriodDescriptor {
	kind: ReportPeriodKind;
	key: string;
	label: string;
	startDate: Date;
	endDate: Date;
}

export interface ReportBudgetSummary {
	limit: number;
	spent: number;
	remaining: number;
	usagePercentage: number | null;
	warningThresholdPercentage: number;
	projectedSpent: number | null;
	projectedDelta: number | null;
	alertLevel: ReportBudgetAlertLevel;
	alertsEnabled: boolean;
	forecastEnabled: boolean;
	alertState: ReportBudgetAlertState;
}

export type ReportBudgetAlertLevel = 'none' | 'ok' | 'warning' | 'forecast' | 'critical';

export interface ReportBudgetAlertState {
	sentWarning: boolean;
	sentForecast: boolean;
	sentCritical: boolean;
	lastAlertAt: string | null;
}

export type FinanceReportSection =
	| 'summary'
	| 'expense-categories'
	| 'income-categories'
	| 'expense-chart'
	| 'income-chart'
	| 'trend'
	| 'transactions';
