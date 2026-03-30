import ExpenseManagerPlugin from '../../main';

export function registerAddQrExpenseCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-expense-via-qr',
		name: 'Add expense from receipt image QR',
		callback: async () => {
			await plugin.handleAddQrExpense();
		}
	});
}
