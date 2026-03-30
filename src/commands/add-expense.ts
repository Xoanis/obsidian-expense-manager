import ExpenseManagerPlugin from '../../main';

export function registerAddExpenseCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-expense',
		name: 'Add expense from text or receipt QR text',
		callback: async () => {
			await plugin.handleAddExpense();
		}
	});
}
