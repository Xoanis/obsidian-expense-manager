import { App } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData } from '../types';
import { ProverkaChekaClient } from '../utils/api-client';
import { QrModal } from '../ui/qr-modal';

export class QrHandler extends BaseHandler {
	private app: App;
	private apiKey: string;
	private autoSave: boolean;
	private localOnly: boolean;

	constructor(
		app: App,
		apiKey: string,
		autoSave: boolean = false,
		localOnly: boolean = false
	) {
		super();
		this.app = app;
		this.apiKey = apiKey;
		this.autoSave = autoSave;
		this.localOnly = localOnly;
	}

	getName(): string {
		return 'qr';
	}

	async handle(): Promise<HandlerResult> {
		if (!ProverkaChekaClient.validateApiKey(this.apiKey)) {
			return {
				success: false,
				error: 'ProverkaCheka API token is not configured. Please set it in plugin settings.'
			};
		}

		const client = new ProverkaChekaClient(this.apiKey, this.localOnly);

		return new Promise((resolve) => {
			const modal = new QrModal(this.app, client, this.autoSave);

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
