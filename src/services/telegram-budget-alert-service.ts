import { App } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import { PeriodReport, ReportBudgetAlertLevel } from '../types';
import { getTelegramBotApiV2 } from '../integrations/telegram-v2/client';
import { ITelegramBotPluginAPIv1 } from '../../telegram_plugin_api';

export class TelegramBudgetAlertService {
	constructor(
		private readonly app: App,
		private readonly settings: ExpenseManagerSettings,
	) {}

	async sendBudgetAlert(report: PeriodReport, level: ReportBudgetAlertLevel): Promise<boolean> {
		if (!this.settings.enableTelegramIntegration || !this.settings.sendProactiveTelegramBudgetAlerts) {
			return false;
		}
		if (!report.budget || (level !== 'warning' && level !== 'forecast' && level !== 'critical')) {
			return false;
		}

		const message = this.formatBudgetAlertMessage(report, level);
		if (!message) {
			return false;
		}

		const apiV2 = getTelegramBotApiV2(this.app);
		if (apiV2) {
			await apiV2.sendMessage(message);
			return true;
		}

		const apiV1 = this.getTelegramApiV1();
		if (apiV1) {
			await apiV1.sendMessage(message);
			return true;
		}

		return false;
	}

	private getTelegramApiV1(): ITelegramBotPluginAPIv1 | null {
		// @ts-ignore runtime plugin registry
		const telegramPlugin = this.app.plugins?.plugins?.['obsidian-telegram-bot-plugin'];
		if (!telegramPlugin || typeof telegramPlugin.getAPIv1 !== 'function') {
			return null;
		}
		return telegramPlugin.getAPIv1() as ITelegramBotPluginAPIv1 | null;
	}

	private formatBudgetAlertMessage(report: PeriodReport, level: ReportBudgetAlertLevel): string | null {
		if (!report.budget) {
			return null;
		}

		const monthArg = `${report.startDate.getFullYear()}-${String(report.startDate.getMonth() + 1).padStart(2, '0')}`;
		const meta = this.getAlertMeta(level);
		const lines = [
			`${meta.icon} ${meta.title}: ${report.periodLabel}`,
			'',
			`Priority: ${meta.priority}`,
			`Spent: ${this.formatMoney(report.budget.spent)} RUB of ${this.formatMoney(report.budget.limit)} RUB`,
			`Used: ${report.budget.usagePercentage === null ? '-' : `${report.budget.usagePercentage.toFixed(1)}%`}`,
		];

		if (level === 'critical') {
			lines.push(`Over budget: ${this.formatMoney(Math.abs(report.budget.remaining))} RUB`);
		} else if (level === 'forecast') {
			lines.push(`Projected month end: ${this.formatMoney(report.budget.projectedSpent ?? 0)} RUB`);
			lines.push(`Expected overrun: ${this.formatMoney(Math.max(0, report.budget.projectedDelta ?? 0))} RUB`);
		} else {
			lines.push(`Remaining: ${this.formatMoney(report.budget.remaining)} RUB`);
		}

		lines.push(`Closing balance: ${this.formatMoney(report.closingBalance)} RUB`);
		lines.push('');
		lines.push(`Open full report: /finance_report ${monthArg}`);
		lines.push(`Quick summary: /finance_summary ${monthArg}`);
		return lines.join('\n');
	}

	private getAlertMeta(level: ReportBudgetAlertLevel): {
		icon: string;
		title: string;
		priority: string;
	} {
		if (level === 'critical') {
			return {
				icon: '🚨',
				title: 'Budget exceeded',
				priority: 'high',
			};
		}
		if (level === 'forecast') {
			return {
				icon: '⚠️',
				title: 'Budget overrun forecast',
				priority: 'medium',
			};
		}
		return {
			icon: '⚠️',
			title: 'Budget warning',
			priority: 'medium',
		};
	}

	private formatMoney(value: number): string {
		return new Intl.NumberFormat('ru-RU', {
			minimumFractionDigits: 0,
			maximumFractionDigits: 2,
		}).format(value);
	}
}
