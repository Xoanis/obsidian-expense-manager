import { IParaCoreApi } from './types';

export function registerFinanceTelegramHelpContributions(api: IParaCoreApi): void {
	api.registerTelegramHelpContribution?.({
		id: 'finance.telegram-help',
		domainId: 'finance',
		order: 100,
		renderHelp: () => [
			'Finance Telegram commands:',
			'/expense - capture an expense proposal from text, image, or PDF',
			'/income - capture an income proposal from text, image, or PDF',
			'/finance_record - parse signed or prefixed finance text',
			'/finance_summary - show monthly finance summary',
			'/finance_report - open monthly finance report',
			'',
			'Examples:',
			'/expense 500 Lunch | area=Health',
			'/income 50000 Salary | area=Career',
			'/finance_record +5000 Bonus',
			'/finance_report 2026-03',
		].join('\n'),
	});
}
