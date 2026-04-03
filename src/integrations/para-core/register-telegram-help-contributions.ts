import { IParaCoreApi } from './types';

export function registerFinanceTelegramHelpContributions(api: IParaCoreApi): void {
	api.registerTelegramHelpContribution?.({
		id: 'finance.telegram-help',
		domainId: 'finance',
		order: 100,
		renderHelp: () => [
			'Finance Telegram commands:',
			'/finance_record - capture a finance proposal from text, raw receipt QR text, image, or PDF',
			'/finance_summary - show monthly finance summary',
			'/finance_report - open monthly finance report',
			'',
			'Examples:',
			'/finance_record expense 500 Lunch | area=Health',
			'/finance_record income 50000 Salary | area=Career',
			'/finance_record +5000 Bonus',
			'/finance_record t=20260316T1007&s=1550.00&fn=9999078900012345&i=12345&fp=2890123456&n=1',
			'/finance_report 2026-03',
		].join('\n'),
	});
}
