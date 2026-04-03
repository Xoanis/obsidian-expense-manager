import ExpenseManagerPlugin from '../../main';

export function registerSetCurrentMonthBudgetCommand(plugin: ExpenseManagerPlugin) {
	plugin.addCommand({
		id: 'set-current-month-budget',
		name: 'Set current month budget',
		callback: async () => {
			await plugin.handleSetCurrentMonthBudget();
		},
	});
}
