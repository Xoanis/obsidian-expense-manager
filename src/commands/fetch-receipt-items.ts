import ExpenseManagerPlugin from '../../main';

export function registerFetchReceiptItemsCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'fetch-receipt-items-from-proverkacheka',
		name: 'Fetch receipt items from ProverkaCheka',
		checkCallback: (checking) => {
			const canRun = plugin.canFetchReceiptItemsFromActiveNote();
			if (canRun && !checking) {
				void plugin.handleFetchReceiptItemsFromActiveNote();
			}

			return canRun;
		},
	});
}
