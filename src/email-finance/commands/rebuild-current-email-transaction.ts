import ExpenseManagerPlugin from '../../../main';

export function registerRebuildCurrentEmailTransactionCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'rebuild-current-email-transaction',
		name: 'Rebuild current email transaction',
		callback: async () => {
			await plugin.handleRebuildCurrentEmailTransaction();
		},
	});
}
