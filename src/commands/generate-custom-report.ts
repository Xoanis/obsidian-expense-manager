import ExpenseManagerPlugin from '../../main';

export function registerGenerateCustomReportCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'generate-custom-expense-report',
		name: 'Generate finance report for custom period',
		callback: async () => {
			await plugin.handleGenerateCustomReport();
		},
	});
}
