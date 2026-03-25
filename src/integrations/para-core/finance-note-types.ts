import { PeriodReport, TransactionData } from '../../types';
import { formatDateTime } from '../../utils/frontmatter';
import { NoteTypeDefinition, TemplateContext } from './types';

type FinanceTransactionNoteType = 'finance-expense' | 'finance-income';
type FinanceTransactionStatus = 'recorded' | 'archived';
type FinanceReportStatus = 'generated' | 'archived';

interface FinanceTransactionFrontmatter {
	type: FinanceTransactionNoteType;
	status: FinanceTransactionStatus;
	domain: 'finance';
	created: string;
	date: string;
	dateTime: string;
	amount: number;
	currency: string;
	comment: string;
	area?: string | null;
	project?: string | null;
	category?: string | null;
	source: string;
	tags: string[];
	fn?: string;
	fd?: string;
	fp?: string;
	details?: TransactionData['details'];
}

interface FinanceReportFrontmatter {
	type: 'finance-report';
	status: FinanceReportStatus;
	domain: 'finance';
	created: string;
	periodStart: string;
	periodEnd: string;
	currency: string;
	totalExpenses: number;
	totalIncome: number;
	balance: number;
	tags: string[];
	report?: PeriodReport;
}

const TRANSACTIONS_FOLDER_KEY = 'records:/Finance/Transactions';
const REPORTS_FOLDER_KEY = 'records:/Finance/Reports';

export function getFinanceNoteTypes(): Array<NoteTypeDefinition<any>> {
	return [
		createFinanceTransactionNoteType('finance-expense', 'Finance Expense', 'expense'),
		createFinanceTransactionNoteType('finance-income', 'Finance Income', 'income'),
		createFinanceReportNoteType(),
	];
}

function createFinanceTransactionNoteType(
	type: FinanceTransactionNoteType,
	displayName: string,
	categoryTag: 'expense' | 'income',
): NoteTypeDefinition<FinanceTransactionFrontmatter> {
	return {
		type,
		displayName,
		folderKey: TRANSACTIONS_FOLDER_KEY,
		fileNameStrategy: 'title',
		requiredFields: ['type', 'status', 'domain', 'created', 'dateTime', 'amount', 'currency', 'source'],
		allowedStatuses: ['recorded', 'archived'] as const,
		defaultFrontmatter: (date, timestamp) => ({
			type,
			status: 'recorded',
			domain: 'finance',
			created: date,
			date,
			dateTime: new Date(`${date}T00:00:00`).toISOString(),
			amount: 0,
			currency: 'RUB',
			comment: '',
			area: null,
			project: null,
			category: null,
			source: 'manual',
			tags: ['finance', categoryTag],
			details: [],
		}),
		template: (ctx) => renderFinanceTransactionTemplate(ctx, categoryTag),
	};
}

function createFinanceReportNoteType(): NoteTypeDefinition<FinanceReportFrontmatter> {
	return {
		type: 'finance-report',
		displayName: 'Finance Report',
		folderKey: REPORTS_FOLDER_KEY,
		fileNameStrategy: 'title',
		requiredFields: ['type', 'status', 'domain', 'created', 'periodStart', 'periodEnd', 'currency'],
		allowedStatuses: ['generated', 'archived'] as const,
		defaultFrontmatter: (date) => ({
			type: 'finance-report',
			status: 'generated',
			domain: 'finance',
			created: date,
			periodStart: date,
			periodEnd: date,
			currency: 'RUB',
			totalExpenses: 0,
			totalIncome: 0,
			balance: 0,
			tags: ['finance', 'report'],
		}),
		template: (ctx) => renderFinanceReportTemplate(ctx),
	};
}

function renderFinanceTransactionTemplate(
	ctx: TemplateContext<FinanceTransactionFrontmatter>,
	categoryTag: 'expense' | 'income',
): string {
	const frontmatter = ctx.frontmatter;
	const label = categoryTag === 'expense' ? 'Expense' : 'Income';
	const selectedFrontmatter = {
		type: frontmatter.type,
		status: frontmatter.status,
		domain: frontmatter.domain,
		created: frontmatter.created,
		date: frontmatter.date,
		dateTime: frontmatter.dateTime,
		amount: frontmatter.amount,
		currency: frontmatter.currency,
		comment: frontmatter.comment,
		area: frontmatter.area,
		project: frontmatter.project,
		category: frontmatter.category,
		source: frontmatter.source,
		tags: frontmatter.tags,
		fn: frontmatter.fn,
		fd: frontmatter.fd,
		fp: frontmatter.fp,
	};

	const body: string[] = [
		`# ${label}: ${frontmatter.comment || ctx.title}`,
		'',
		`**Date:** ${formatDateTime(frontmatter.dateTime)}`,
		`**Amount:** ${Number(frontmatter.amount).toFixed(2)} ${frontmatter.currency}`,
		`**Category:** ${frontmatter.category || 'uncategorized'}`,
		frontmatter.area ? `**Area:** ${frontmatter.area}` : '',
		frontmatter.project ? `**Project:** ${frontmatter.project}` : '',
		`**Source:** ${frontmatter.source}`,
	];

	if (frontmatter.details && frontmatter.details.length > 0) {
		body.push('', '## Items', '');
		for (const detail of frontmatter.details) {
			const lineTotal = (detail.price * detail.quantity).toFixed(2);
			body.push(`- ${detail.name}: ${detail.price.toFixed(2)} x ${detail.quantity} = ${lineTotal}`);
		}
	}

	if (frontmatter.tags && frontmatter.tags.length > 0) {
		body.push('', '## Tags', '', frontmatter.tags.map((tag) => `#${tag}`).join(' '));
	}

	return `${renderFrontmatter(selectedFrontmatter)}\n\n${body.filter(Boolean).join('\n')}\n`;
}

function renderFinanceReportTemplate(
	ctx: TemplateContext<FinanceReportFrontmatter>,
): string {
	const frontmatter = ctx.frontmatter;
	const report = frontmatter.report;
	const selectedFrontmatter = {
		type: frontmatter.type,
		status: frontmatter.status,
		domain: frontmatter.domain,
		created: frontmatter.created,
		periodStart: frontmatter.periodStart,
		periodEnd: frontmatter.periodEnd,
		currency: frontmatter.currency,
		totalExpenses: frontmatter.totalExpenses,
		totalIncome: frontmatter.totalIncome,
		balance: frontmatter.balance,
		tags: frontmatter.tags,
	};

	const body: string[] = [
		'# Financial Report',
		'',
		`**Period:** ${frontmatter.periodStart} - ${frontmatter.periodEnd}`,
		'',
		'## Summary',
		'',
		`- Total income: ${Number(frontmatter.totalIncome).toFixed(2)} ${frontmatter.currency}`,
		`- Total expenses: ${Number(frontmatter.totalExpenses).toFixed(2)} ${frontmatter.currency}`,
		`- Balance: ${Number(frontmatter.balance).toFixed(2)} ${frontmatter.currency}`,
	];

	if (report) {
		const incomes = report.transactions.filter((item) => item.type === 'income');
		const expenses = report.transactions.filter((item) => item.type === 'expense');
		body.push(
			'',
			'## Income',
			'',
			...renderReportTableLines(incomes),
			'',
			'## Expenses',
			'',
			...renderReportTableLines(expenses),
		);
	}

	return `${renderFrontmatter(selectedFrontmatter)}\n\n${body.join('\n')}\n`;
}

function renderReportTableLines(items: TransactionData[]): string[] {
	if (items.length === 0) {
		return ['_No records in this period._'];
	}

	const lines = [
		'| Date | Amount | Comment | Category |',
		'|------|--------|---------|----------|',
	];
	for (const item of items) {
		const date = new Date(item.dateTime).toLocaleDateString();
		lines.push(
			`| ${date} | ${item.amount.toFixed(2)} ${item.currency} | ${escapePipes(item.comment)} | ${escapePipes(item.category || '')} |`,
		);
	}
	return lines;
}

function renderFrontmatter(values: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null) {
			continue;
		}

		if (Array.isArray(value)) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
			continue;
		}

		if (typeof value === 'string') {
			lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
			continue;
		}

		lines.push(`${key}: ${value}`);
	}
	lines.push('---');
	return lines.join('\n');
}

function escapePipes(value: string): string {
	return value.replace(/\|/g, '\\|');
}
