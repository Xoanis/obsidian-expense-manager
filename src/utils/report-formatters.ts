import { PeriodReport, ReportBudgetSummary } from '../types';
import { TELEGRAM_CHART_DESCRIPTORS } from '../services/telegram-chart-service';

export type MonthlyReportSection = 'summary' | 'categories' | 'top-expenses' | 'projects' | 'areas' | 'charts';

export function formatMonthlySummaryMessage(
	report: PeriodReport,
	previousReport?: PeriodReport | null,
): string {
	const lines = [
		`Finance report: ${report.periodLabel}`,
		'',
		`Expenses: ${formatMoney(report.totalExpenses)} RUB`,
		`Income: ${formatMoney(report.totalIncome)} RUB`,
		`Opening balance: ${formatMoney(report.openingBalance)} RUB`,
		`Closing balance: ${formatMoney(report.closingBalance)} RUB`,
	];

	if (report.budget) {
		lines.push('');
		lines.push(`Budget: ${formatMoney(report.budget.limit)} RUB`);
		lines.push(`Used: ${report.budget.usagePercentage === null ? '-' : `${report.budget.usagePercentage.toFixed(1)}%`}`);
		lines.push(`Remaining: ${formatMoney(report.budget.remaining)} RUB`);
		lines.push(`Status: ${formatBudgetStatus(report.budget)}`);

		const budgetAlertLines = formatBudgetAlertBlock(report.budget);
		if (budgetAlertLines.length > 0) {
			lines.push('');
			lines.push(...budgetAlertLines);
		}
	}

	if (previousReport) {
		lines.push('');
		lines.push(`vs ${previousReport.periodLabel}:`);
		lines.push(`Expenses ${formatSignedPercentChange(report.totalExpenses, previousReport.totalExpenses)}`);
		lines.push(`Income ${formatSignedPercentChange(report.totalIncome, previousReport.totalIncome)}`);
		lines.push(`Closing balance ${formatSignedAmount(report.closingBalance - previousReport.closingBalance)} RUB`);
	}

	const topCategories = report.expenseByCategory.slice(0, 3);
	if (topCategories.length > 0) {
		lines.push('');
		lines.push('Top expense categories:');
		topCategories.forEach((category, index) => {
			lines.push(`${index + 1}. ${category.category} — ${formatMoney(category.total)} RUB`);
		});
	}

	return lines.join('\n');
}

export function formatMonthlyCategoriesMessage(report: PeriodReport): string {
	const lines = [`Categories: ${report.periodLabel}`];

	const expenseCategories = report.expenseByCategory.slice(0, 8);
	lines.push('');
	lines.push('Expense categories');
	if (expenseCategories.length === 0) {
		lines.push('- No expenses in this period');
	} else {
		for (const category of expenseCategories) {
			lines.push(`- ${category.category}: ${category.total.toFixed(2)} RUB (${category.percentage.toFixed(1)}%)`);
		}
	}

	const incomeCategories = report.incomeByCategory.slice(0, 6);
	lines.push('');
	lines.push('Income categories');
	if (incomeCategories.length === 0) {
		lines.push('- No income in this period');
	} else {
		for (const category of incomeCategories) {
			lines.push(`- ${category.category}: ${category.total.toFixed(2)} RUB (${category.percentage.toFixed(1)}%)`);
		}
	}

	return lines.join('\n');
}

export function formatMonthlyTopExpensesMessage(report: PeriodReport): string {
	const expenses = report.transactions
		.filter((transaction) => transaction.type === 'expense')
		.slice()
		.sort((left, right) => right.amount - left.amount)
		.slice(0, 10);

	const lines = [`Top expenses: ${report.periodLabel}`, ''];
	if (expenses.length === 0) {
		lines.push('No expenses in this period.');
		return lines.join('\n');
	}

	for (const transaction of expenses) {
		lines.push(
			`- ${transaction.dateTime.slice(0, 10)} ${transaction.amount.toFixed(2)} RUB ${transaction.description}`,
		);
	}

	return lines.join('\n');
}

export function formatMonthlyProjectsMessage(report: PeriodReport): string {
	return formatContextBreakdownMessage(report, 'project', 'Projects');
}

export function formatMonthlyAreasMessage(report: PeriodReport): string {
	return formatContextBreakdownMessage(report, 'area', 'Areas');
}

export function formatMonthlySectionMessage(
	report: PeriodReport,
	section: MonthlyReportSection,
	previousReport?: PeriodReport | null,
): string {
	if (section === 'projects') {
		return formatMonthlyProjectsMessage(report);
	}
	if (section === 'areas') {
		return formatMonthlyAreasMessage(report);
	}
	if (section === 'charts') {
		const lines = [
			`Charts: ${report.periodLabel}`,
			'',
			'Choose a chart to generate:',
		];
		for (const chart of TELEGRAM_CHART_DESCRIPTORS) {
			lines.push(`- ${chart.label}: ${chart.description}`);
		}
		return lines.join('\n');
	}
	if (section === 'categories') {
		return formatMonthlyCategoriesMessage(report);
	}
	if (section === 'top-expenses') {
		return formatMonthlyTopExpensesMessage(report);
	}
	return formatMonthlySummaryMessage(report, previousReport);
}

export function formatMonthlyReportMessages(report: PeriodReport, previousReport?: PeriodReport | null): string[] {
	return [
		formatMonthlySummaryMessage(report, previousReport),
		formatMonthlyCategoriesMessage(report),
		formatMonthlyTopExpensesMessage(report),
		formatMonthlyProjectsMessage(report),
		formatMonthlyAreasMessage(report),
	];
}

function formatSignedPercentChange(current: number, previous: number): string {
	if (previous === 0) {
		if (current === 0) {
			return '0.0%';
		}
		return '+new';
	}

	const delta = ((current - previous) / previous) * 100;
	return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

function formatSignedAmount(value: number): string {
	return `${value >= 0 ? '+' : ''}${formatMoney(value)}`;
}

function formatBudgetStatus(budget: ReportBudgetSummary): string {
	if (!budget.alertsEnabled) {
		return 'alerts disabled';
	}
	if (budget.alertLevel === 'critical') {
		return 'exceeded';
	}
	if (budget.alertLevel === 'forecast') {
		return 'forecast overrun';
	}
	if (budget.alertLevel === 'warning') {
		return 'warning';
	}
	return 'ok';
}

function formatBudgetAlertBlock(budget: ReportBudgetSummary): string[] {
	if (!budget.alertsEnabled || budget.alertLevel === 'none' || budget.alertLevel === 'ok') {
		return [];
	}

	if (budget.alertLevel === 'critical') {
		return [
			'Budget alert: exceeded',
			`Used: ${budget.usagePercentage === null ? '-' : `${budget.usagePercentage.toFixed(1)}%`} of ${formatMoney(budget.limit)} RUB`,
			`Over budget: ${formatMoney(Math.abs(budget.remaining))} RUB`,
		];
	}

	if (budget.alertLevel === 'forecast') {
		return [
			'Budget alert: forecast overrun',
			`Used: ${budget.usagePercentage === null ? '-' : `${budget.usagePercentage.toFixed(1)}%`} of ${formatMoney(budget.limit)} RUB`,
			`Projected month end: ${formatMoney(budget.projectedSpent ?? 0)} RUB`,
			`Expected overrun: ${formatMoney(Math.max(0, budget.projectedDelta ?? 0))} RUB`,
		];
	}

	return [
		'Budget alert: warning',
		`Used: ${budget.usagePercentage === null ? '-' : `${budget.usagePercentage.toFixed(1)}%`} of ${formatMoney(budget.limit)} RUB`,
		`Remaining: ${formatMoney(budget.remaining)} RUB`,
	];
}

function formatMoney(value: number): string {
	return new Intl.NumberFormat('ru-RU', {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(value);
}

function formatContextBreakdownMessage(
	report: PeriodReport,
	field: 'project' | 'area',
	title: 'Projects' | 'Areas',
): string {
	const groups = new Map<string, {
		expenses: number;
		income: number;
		count: number;
	}>();

	for (const transaction of report.transactions) {
		const rawValue = field === 'project' ? transaction.project : transaction.area;
		const key = normalizeContextLabel(rawValue);
		const existing = groups.get(key) || { expenses: 0, income: 0, count: 0 };
		if (transaction.type === 'income') {
			existing.income += transaction.amount;
		} else {
			existing.expenses += transaction.amount;
		}
		existing.count += 1;
		groups.set(key, existing);
	}

	const rows = Array.from(groups.entries())
		.map(([label, values]) => ({
			label,
			expenses: values.expenses,
			income: values.income,
			balance: values.income - values.expenses,
			count: values.count,
			activity: Math.max(values.expenses, values.income),
		}))
		.sort((left, right) => right.activity - left.activity)
		.slice(0, 10);

	const lines = [`${title}: ${report.periodLabel}`, ''];
	if (rows.length === 0) {
		lines.push(`No ${title.toLowerCase()} linked in this period.`);
		return lines.join('\n');
	}

	for (const row of rows) {
		lines.push(`${row.label}`);
		lines.push(`  Expenses: ${row.expenses.toFixed(2)} RUB | Income: ${row.income.toFixed(2)} RUB | Balance: ${row.balance.toFixed(2)} RUB | Transactions: ${row.count}`);
	}

	return lines.join('\n');
}

function normalizeContextLabel(value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return 'Unlinked';
	}

	const wikiMatch = trimmed.match(/^\[\[([\s\S]+?)\]\]$/);
	const raw = wikiMatch ? wikiMatch[1] : trimmed;
	const noAlias = raw.split('|')[0]?.trim() || raw;
	const noHeading = noAlias.split('#')[0]?.trim() || noAlias;
	const segments = noHeading.split('/');
	return segments[segments.length - 1] || noHeading;
}
