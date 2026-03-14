import ExpenseManagerPlugin from '../../main';

export function registerAddIncomeCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-income',
		name: 'Add income',
		callback: async () => {
			await plugin.handleAddIncome();
		}
	});
}
