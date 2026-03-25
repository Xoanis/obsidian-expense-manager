import ExpenseManagerPlugin from '../../main';

export function registerGenerateReportFileCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'generate-expense-report-file',
		name: 'Save current month finance report',
		callback: async () => {
			await plugin.handleGenerateReportFile();
		}
	});
}
