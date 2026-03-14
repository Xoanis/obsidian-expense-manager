import { App } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData, TransactionType } from '../types';
import { ExpenseModal } from '../ui/expense-modal';

export class ManualHandler extends BaseHandler {
	private app: App;
	private defaultType: TransactionType;
	private defaultCurrency: string;
	private categories: string[];

	constructor(
		app: App, 
		defaultType: TransactionType = 'expense',
		defaultCurrency: string = 'RUB',
		categories: string[] = []
	) {
		super();
		this.app = app;
		this.defaultType = defaultType;
		this.defaultCurrency = defaultCurrency;
		this.categories = categories;
	}

	getName(): string {
		return 'manual';
	}

	async handle(): Promise<HandlerResult> {
		return new Promise((resolve) => {
			const modal = new ExpenseModal(
				this.app,
				this.defaultType,
				this.defaultCurrency,
				this.categories
			);

			modal.onComplete = (data: TransactionData) => {
				resolve({
					success: true,
					data
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
