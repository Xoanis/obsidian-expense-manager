import ExpenseManagerPlugin from '../../main';

export function registerAddExpenseCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-expense',
		name: 'Add expense',
		callback: async () => {
			await plugin.handleAddExpense();
		}
	});
}
