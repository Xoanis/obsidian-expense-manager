import ExpenseManagerPlugin from '../../main';

export function registerSyncCurrentTransactionNoteCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'sync-current-finance-note-storage',
		name: 'Sync current finance note filename and folder',
		callback: async () => {
			await plugin.handleSyncCurrentFinanceNoteStorage();
		},
	});
}
