import ExpenseManagerPlugin from '../../main';

export function registerAddIncomeCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-income',
		name: 'Add income from text or receipt QR text',
		callback: async () => {
			await plugin.handleAddIncome();
		}
	});
}
