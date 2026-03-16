import { TransactionType } from './types';

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
	showConfirmationNotice: true
};
