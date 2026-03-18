import { App } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData } from '../types';
import { ExpenseManagerSettings } from '../settings';
import { ProverkaChekaClient } from '../utils/api-client';
import { QrModal } from '../ui/qr-modal';

export class QrHandler extends BaseHandler {
	private app: App;
	private settings: ExpenseManagerSettings;

	constructor(
		app: App,
		settings: ExpenseManagerSettings
	) {
		super();
		this.app = app;
		this.settings = settings;
	}

	getName(): string {
		return 'qr';
	}

	async handle(): Promise<HandlerResult> {
		if (!ProverkaChekaClient.validateApiKey(this.settings.proverkaChekaApiKey)) {
			return {
				success: false,
				error: 'ProverkaCheka API token is not configured. Please set it in plugin settings.'
			};
		}

		const client = new ProverkaChekaClient(
			this.settings.proverkaChekaApiKey, 
			this.settings.localQrOnly
		);

		return new Promise((resolve) => {
			const modal = new QrModal(this.app, client, this.settings.autoSaveQrExpenses);

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
