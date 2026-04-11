import { App } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData, TransactionType } from '../types';
import { ExpenseManagerSettings } from '../settings';
import { ExpenseModal } from '../ui/expense-modal';

export class ManualHandler extends BaseHandler {
	private app: App;
	private settings: ExpenseManagerSettings;
	private type: TransactionType;

	constructor(
		app: App, 
		settings: ExpenseManagerSettings,
        type: TransactionType
	) {
		super();
		this.app = app;
		this.settings = settings;
		this.type = type;
	}

	getName(): string {
		return 'manual';
	}

	async handle(): Promise<HandlerResult> {
		return new Promise((resolve) => {
			const modal = new ExpenseModal(
				this.app,
				this.type,
				this.settings.defaultCurrency,
				this.type === 'expense' ? this.settings.expenseCategories : this.settings.incomeCategories
			);

			modal.onComplete = (data: TransactionData) => {
				resolve({
					success: true,
					data,
				});
			};

			modal.onCancel = () => {
				resolve({
					success: false,
					error: 'User cancelled'
				});
			};

			modal.open();
		});
	}
}
