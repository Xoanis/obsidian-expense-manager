import ExpenseManagerPlugin from '../../../main';

export function registerSyncFinanceEmailsCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'sync-finance-emails',
		name: 'Sync finance emails',
		callback: async () => {
			await plugin.handleSyncFinanceEmails();
		},
	});
}
