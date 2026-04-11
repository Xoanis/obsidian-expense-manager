import { App } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import type { EmailFinanceSyncSummary } from '../email-finance/sync/email-finance-sync-service';
import { getTelegramBotApi } from '../integrations/telegram/client';
import {
	formatEmailSyncTelegramNotification,
	type TelegramEmailSyncNotificationOptions,
} from './telegram-email-sync-notification-format';

export class TelegramEmailSyncNotificationService {
	constructor(
		private readonly app: App,
		private readonly settings: ExpenseManagerSettings,
	) {}

	async sendEmailSyncNotification(
		summary: EmailFinanceSyncSummary,
		options: TelegramEmailSyncNotificationOptions,
	): Promise<boolean> {
		if (!this.settings.enableTelegramIntegration || !this.settings.sendTelegramEmailSyncNotifications) {
			return false;
		}
		if (summary.status !== 'success' || summary.createdPendingNotes <= 0) {
			return false;
		}

		const telegramApi = getTelegramBotApi(this.app);
		if (!telegramApi) {
			return false;
		}

		await telegramApi.sendMessage(formatEmailSyncTelegramNotification(summary, options));
		return true;
	}
}
