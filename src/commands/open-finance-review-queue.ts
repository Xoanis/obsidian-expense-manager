import ExpenseManagerPlugin from '../../main';

export function registerOpenFinanceReviewQueueCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'open-finance-review-queue',
		name: 'Open finance review queue',
		callback: async () => {
			await plugin.handleOpenFinanceReviewQueue();
		},
	});
}
