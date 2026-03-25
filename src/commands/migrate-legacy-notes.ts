import ExpenseManagerPlugin from '../../main';

export function registerMigrateLegacyNotesCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'migrate-legacy-finance-notes',
		name: 'Migrate legacy finance notes',
		callback: async () => {
			await plugin.handleMigrateLegacyNotes();
		},
	});
}
