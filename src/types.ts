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
	
	/** Comment or description */
	comment: string;
	
	/** Tags/categories for the transaction */
	tags: string[];
	
	/** Primary category (derived from tags or predefined) */
	category?: string;
	
	/** Additional details (e.g., items from receipt) */
	details?: TransactionDetail[];
	
	/** Source of the transaction (manual, qr, telegram, pdf, etc.) */
	source: TransactionSource;
	
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
	/** Start date of period */
	startDate: Date;
	
	/** End date of period */
	endDate: Date;
	
	/** Total expenses */
	totalExpenses: number;
	
	/** Total income */
	totalIncome: number;
	
	/** Balance (income - expenses) */
	balance: number;
	
	/** Transactions in this period */
	transactions: TransactionData[];
	
	/** Grouped by category */
	byCategory: CategorySummary[];
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
