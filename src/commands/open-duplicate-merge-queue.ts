import ExpenseManagerPlugin from '../../main';

export function registerOpenDuplicateMergeQueueCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'open-duplicate-merge-queue',
		name: 'Open duplicate merge queue',
		callback: async () => {
			await plugin.handleOpenDuplicateMergeQueue();
		},
	});
}
