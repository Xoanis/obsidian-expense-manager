import { TransactionData } from '../../types';
import { NoteTypeDefinition, TemplateContext } from './types';

type FinanceTransactionNoteType = 'finance-expense' | 'finance-income';
type FinanceTransactionStatus = 'recorded' | 'archived';
type FinanceReportStatus = 'generated' | 'archived';

interface FinanceTransactionFrontmatter {
	type: FinanceTransactionNoteType;
	status: FinanceTransactionStatus;
	domain: 'finance';
	created: string;
	dateTime: string;
	amount: number;
	currency: string;
	description: string;
	area?: string | null;
	project?: string | null;
	category?: string | null;
	source: string;
	artifact?: string | null;
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
	periodKind: string;
	periodKey: string;
	periodLabel: string;
	periodStart: string;
	periodEnd: string;
	currency: string;
	openingBalance: number;
	totalExpenses: number;
	totalIncome: number;
	netChange: number;
	closingBalance: number;
	balance: number;
	budget?: number | null;
	tags: string[];
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
			dateTime: new Date(`${date}T00:00:00`).toISOString(),
			amount: 0,
			currency: 'RUB',
			description: '',
			area: null,
			project: null,
			category: null,
			source: 'manual',
			artifact: null,
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
			periodKind: 'custom',
			periodKey: date,
			periodLabel: date,
			periodStart: date,
			periodEnd: date,
			currency: 'RUB',
			openingBalance: 0,
			totalExpenses: 0,
			totalIncome: 0,
			netChange: 0,
			closingBalance: 0,
			balance: 0,
			budget: null,
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
		dateTime: frontmatter.dateTime,
		amount: frontmatter.amount,
		currency: frontmatter.currency,
		description: frontmatter.description,
		area: frontmatter.area,
		project: frontmatter.project,
		category: frontmatter.category,
		source: frontmatter.source,
		artifact: frontmatter.artifact,
		tags: frontmatter.tags,
		fn: frontmatter.fn,
		fd: frontmatter.fd,
		fp: frontmatter.fp,
	};

	const body: string[] = [];

	if (frontmatter.details && frontmatter.details.length > 0) {
		body.push('', '## Items', '');
		for (const detail of frontmatter.details) {
			const lineTotal = (detail.price * detail.quantity).toFixed(2);
			body.push(`- ${detail.name}: ${detail.price.toFixed(2)} x ${detail.quantity} = ${lineTotal}`);
		}
	}

	if (frontmatter.artifact) {
		body.push('', '## Artifact', '', frontmatter.artifact);
	}

	return `${renderFrontmatter(selectedFrontmatter)}${body.length > 0 ? `\n\n${body.filter(Boolean).join('\n')}\n` : '\n'}`;
}

function renderFinanceReportTemplate(
	ctx: TemplateContext<FinanceReportFrontmatter>,
): string {
	const frontmatter = ctx.frontmatter;
	const selectedFrontmatter = {
		type: frontmatter.type,
		status: frontmatter.status,
		domain: frontmatter.domain,
		created: frontmatter.created,
		periodStart: frontmatter.periodStart,
		periodEnd: frontmatter.periodEnd,
		periodKind: frontmatter.periodKind,
		periodKey: frontmatter.periodKey,
		periodLabel: frontmatter.periodLabel,
		currency: frontmatter.currency,
		openingBalance: frontmatter.openingBalance,
		totalExpenses: frontmatter.totalExpenses,
		totalIncome: frontmatter.totalIncome,
		netChange: frontmatter.netChange,
		closingBalance: frontmatter.closingBalance,
		balance: frontmatter.balance,
		budget: frontmatter.budget,
		tags: frontmatter.tags,
	};

	return `${renderFrontmatter(selectedFrontmatter)}\n`;
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

		if (typeof value === 'string' && isDateLikeField(key)) {
			lines.push(`${key}: ${value}`);
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

function isDateLikeField(key: string): boolean {
	return key === 'created' || key === 'dateTime' || key === 'periodStart' || key === 'periodEnd';
}
