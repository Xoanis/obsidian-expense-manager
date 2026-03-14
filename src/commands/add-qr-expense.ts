import ExpenseManagerPlugin from '../../main';

export function registerAddQrExpenseCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-expense-via-qr',
		name: 'Add expense via QR code (receipt)',
		callback: async () => {
			await plugin.handleAddQrExpense();
		}
	});
}
