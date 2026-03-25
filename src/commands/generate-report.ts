import ExpenseManagerPlugin from '../../main';

export function registerGenerateReportCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'generate-expense-report',
		name: 'Open current month finance report',
		callback: async () => {
			await plugin.handleGenerateReport();
		}
	});
}
