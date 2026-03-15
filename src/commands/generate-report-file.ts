import ExpenseManagerPlugin from '../../main';

export function registerGenerateReportFileCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'generate-expense-report-file',
		name: 'Generate monthly expense report as file',
		callback: async () => {
			await plugin.handleGenerateReportFile();
		}
	});
}
