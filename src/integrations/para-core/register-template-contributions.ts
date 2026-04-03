import { normalizePath } from 'obsidian';
import { DashboardContributionMode } from '../../settings';
import { IParaCoreApi } from './types';

export function registerFinanceTemplateContributions(
	api: IParaCoreApi,
	transactionsPath: string,
	attachmentsPath: string,
	dashboardMode: DashboardContributionMode = 'interactive',
): void {
	const transactionsFolder = normalizePath(transactionsPath);
	const reportsFolder = normalizePath(transactionsPath.replace(/\/Transactions$/i, '/Reports'));
	const attachmentsFolder = normalizePath(attachmentsPath);
	const projectSummaryBlock = [
		'### Project Summary',
		'```dataviewjs',
		`const records = dv.pages('"${transactionsFolder}"').where((page) => page.project && String(page.project) === String(dv.current().file.link));`,
		'const expenses = records.where((page) => page.type === "finance-expense");',
		'const incomes = records.where((page) => page.type === "finance-income");',
		'const expenseTotal = expenses.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const incomeTotal = incomes.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const balance = incomeTotal - expenseTotal;',
		'const current = dv.current();',
		'const hasFinanceBudget = Object.prototype.hasOwnProperty.call(current, "finance_budget");',
		'const rawBudget = hasFinanceBudget ? current.finance_budget : current.budget;',
		'const budget = rawBudget === null || rawBudget === undefined || rawBudget === "" ? NaN : Number(rawBudget);',
		'const rows = [',
		'  ["Expenses", expenseTotal.toFixed(2)],',
		'  ["Income", incomeTotal.toFixed(2)],',
		'  ["Balance", balance.toFixed(2)],',
		'  ["Transactions", String(records.length)],',
		'];',
		'if (!Number.isNaN(budget)) {',
		'  const spent = expenseTotal;',
		'  const remaining = budget - spent;',
		'  const usage = budget === 0 ? 0 : (spent / budget) * 100;',
		'  rows.push(["Budget", budget.toFixed(2)]);',
		'  rows.push(["Remaining", remaining.toFixed(2)]);',
		'  rows.push(["Budget used", `${usage.toFixed(1)}%`]);',
		'}',
		'dv.table(["Metric", "Value"], rows);',
		'```',
	].join('\n');

	const areaSummaryBlock = [
		'### Area Summary',
		'```dataviewjs',
		`const records = dv.pages('"${transactionsFolder}"').where((page) => page.area && String(page.area) === String(dv.current().file.link));`,
		'const expenses = records.where((page) => page.type === "finance-expense");',
		'const incomes = records.where((page) => page.type === "finance-income");',
		'const expenseTotal = expenses.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const incomeTotal = incomes.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const projectCount = new Set(records.array().map((page) => page.project).filter(Boolean).map((value) => String(value))).size;',
		'dv.table(["Metric", "Value"], [',
		'  ["Expenses", expenseTotal.toFixed(2)],',
		'  ["Income", incomeTotal.toFixed(2)],',
		'  ["Balance", (incomeTotal - expenseTotal).toFixed(2)],',
		'  ["Transactions", String(records.length)],',
		'  ["Linked projects", String(projectCount)],',
		']);',
		'```',
	].join('\n');

	api.registerTemplateContribution({
		id: 'finance.project-expenses',
		domainId: 'finance',
		target: 'project',
		slot: 'project.domainViews',
		order: 100,
		render: () => [
			'## Finance',
			'',
			'> Add `finance_budget` to project frontmatter if you want budget tracking here.',
			'',
			projectSummaryBlock,
			'',
			'### Finance records',
			'```dataview',
			'TABLE dateTime, type, amount, currency, category, source, area',
			`FROM "${transactionsFolder}"`,
			'WHERE project = this.file.link',
			'SORT dateTime DESC',
			'```',
		].join('\n'),
	});

	api.registerTemplateContribution({
		id: 'finance.area-overview',
		domainId: 'finance',
		target: 'area',
		slot: 'area.domainViews',
		order: 100,
		render: () => [
			'## Finance',
			'',
			areaSummaryBlock,
			'',
			'### Finance records',
			'```dataview',
			'TABLE dateTime, type, amount, currency, category, source, project',
			`FROM "${transactionsFolder}"`,
			'WHERE area = this.file.link',
			'SORT dateTime DESC',
			'```',
		].join('\n'),
	});

	api.registerTemplateContribution({
		id: 'finance.dashboard-current-month-expenses',
		domainId: 'finance',
		target: 'dashboard',
		slot: 'dashboard.domainViews',
		order: 100,
		render: () => buildDashboardContribution(transactionsFolder, reportsFolder, dashboardMode),
	});

	api.registerTemplateContribution({
		id: 'finance.guideline-domain-guide',
		domainId: 'finance',
		target: 'guideline',
		slot: 'guideline.domainGuides',
		order: 100,
		render: () => [
			'## Finance Domain',
			'',
			'### Purpose',
			'- Capture operational finance records inside PARA Core.',
			'- Keep transactions and reports in `Records/` while linking them to areas and projects when needed.',
			'',
			'### Storage',
			`- Transactions root: \`${transactionsPath.replace(/\\/g, '/')}\`.`,
			`- Reports root: \`${reportsFolder.replace(/\\/g, '/')}\`.`,
			`- Receipt attachments root: \`${attachmentsFolder.replace(/\\/g, '/')}/YYYY/MM/\`.`,
			'- Uploaded receipts, screenshots, and finance PDFs are operational artifacts and should stay under `Attachments/Finance/YYYY/MM/`, not in `Records/`.',
			'- Receipt placement uses the transaction date for both the `YYYY/MM` folder and the `YYYY-MM-DD-HH-mm-ss-...` filename prefix.',
			'- Reference material can still live in `Resources/` when it is not an operational finance artifact.',
			'',
			'### Note Types',
			'- `finance-expense` - expense transaction record.',
			'- `finance-income` - income transaction record.',
			'- `finance-report` - generated monthly or period report.',
			'',
			'### Key Fields',
			'| Field | Meaning |',
			'| --- | --- |',
			'| `domain` | Always `finance` for finance records. |',
			'| `amount` | Monetary value of the transaction or report metric. |',
			'| `currency` | Currency code, usually `RUB`. |',
			'| `category` | Expense or income category used for grouping and reports. |',
			'| `source` | Origin of the record, for example telegram, manual, or QR receipt. |',
			'| `area` | Optional wiki-link to the owning responsibility area. |',
			'| `project` | Optional wiki-link to the linked project context. |',
			'',
			'### Workflows',
			'- Create transactions from commands, Telegram capture, QR receipts, or AI-assisted finance intake.',
			'- Link records to `area` and `project` when the expense or income belongs to a specific context.',
			'- Use generated reports for monthly and longer-period summaries.',
			'- Add `finance_budget` to project frontmatter when project-level budget tracking is needed.',
			'',
			'### Telegram',
			'- `/finance_record` - capture a finance proposal from text, signed amounts, raw receipt QR text, image, or PDF.',
			'- `/finance_summary` - show monthly finance summary.',
			'- `/finance_report` - open monthly finance report.',
			'- Project and area Telegram cards can start focused `/finance_record` capture with fixed context.',
			'',
			'### Examples',
			'- `/finance_record expense 500 Lunch | area=Health`',
			'- `/finance_record income 50000 Salary | area=Career`',
			'- `/finance_record +5000 Bonus`',
			'- `/finance_record t=20260316T1007&s=1550.00&fn=9999078900012345&i=12345&fp=2890123456&n=1`',
		].join('\n'),
	});
}

function buildDashboardContribution(
	transactionsFolder: string,
	reportsFolder: string,
	dashboardMode: DashboardContributionMode,
): string {
	const dashboardBlock = buildPluginDashboardBlock(transactionsFolder, reportsFolder, dashboardMode);

	return [
		'## Finance Dashboard',
		'',
		dashboardBlock,
		'',
		'## Finance reports',
		'```dataview',
		'TABLE periodLabel, periodKind, openingBalance, totalExpenses, totalIncome, closingBalance, budget, budget_alert_level',
		`FROM "${reportsFolder}"`,
		'WHERE type = "finance-report"',
		'SORT periodStart DESC',
		'```',
	].join('\n');
}

function buildPluginDashboardBlock(
	transactionsFolder: string,
	reportsFolder: string,
	dashboardMode: DashboardContributionMode,
): string {
	return [
		'```dataviewjs',
		'const container = dv.el("div", "");',
		'const plugin = app.plugins.plugins["expense-manager"];',
		'(async () => {',
		'  if (!plugin?.renderFinanceDashboard) {',
		'    container.setText("Expense Manager plugin API is unavailable.");',
		'    return;',
		'  }',
		`  await plugin.renderFinanceDashboard(container, { mode: "${dashboardMode}", transactionsRoot: "${transactionsFolder}", reportsRoot: "${reportsFolder}" });`,
		'})();',
		'```',
	].join('\n');
}
