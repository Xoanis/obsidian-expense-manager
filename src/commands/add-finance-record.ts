import ExpenseManagerPlugin from '../../main';

export function registerAddFinanceRecordCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'add-finance-record',
		name: 'Add finance record',
		callback: async () => {
			await plugin.handleAddFinanceRecord();
		}
	});
}
