import { TransactionData, TransactionStatus } from '../../types';
import { NoteTypeDefinition, TemplateContext } from './types';

type FinanceTransactionNoteType = 'finance-expense' | 'finance-income';
type FinanceTransactionStatus = TransactionStatus;
type FinanceReportStatus = 'generated' | 'archived';
const FINANCE_TRANSACTION_SOURCES = ['manual', 'qr', 'telegram', 'email', 'pdf', 'api'] as const;
const FINANCE_REPORT_PERIOD_KINDS = ['custom', 'month', 'quarter', 'half-year', 'year'] as const;

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
	email_msg_id?: string;
	email_provider?: string;
	email_mailbox_scope?: string;
	duplicate_of?: string | null;
	fn?: string;
	fd?: string;
	fp?: string;
	receiptOperationType?: TransactionData['receiptOperationType'];
	ProverkaCheka?: boolean;
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
		requiredFields: ['type', 'status', 'domain', 'created', 'dateTime', 'amount', 'currency', 'description', 'source', 'tags'],
		allowedStatuses: ['recorded', 'pending-approval', 'needs-attention', 'duplicate', 'rejected', 'archived'] as const,
		defaultFrontmatter: (date, timestamp) => ({
			type,
			status: 'recorded',
			domain: 'finance',
			created: date,
			dateTime: resolveTemplateFriendlyDateTime(date, timestamp),
			amount: 0,
			currency: 'RUB',
			description: '',
			area: null,
			project: null,
			category: null,
			source: 'manual',
			artifact: null,
			tags: ['finance', categoryTag],
		}),
		template: (ctx) => renderFinanceTransactionTemplate(ctx, categoryTag),
	};
}

function resolveTemplateFriendlyDateTime(date: string, timestamp: string): string {
	if (isTemplatePlaceholder(timestamp)) {
		return timestamp;
	}

	const parsed = new Date(`${date}T00:00:00`);
	if (Number.isNaN(parsed.getTime())) {
		return timestamp || date;
	}

	return parsed.toISOString();
}

function isTemplatePlaceholder(value: string): boolean {
	return typeof value === 'string' && value.includes('{{') && value.includes('}}');
}

function createFinanceReportNoteType(): NoteTypeDefinition<FinanceReportFrontmatter> {
	return {
		type: 'finance-report',
		displayName: 'Finance Report',
		folderKey: REPORTS_FOLDER_KEY,
		fileNameStrategy: 'title',
		requiredFields: [
			'type',
			'status',
			'domain',
			'created',
			'periodKind',
			'periodKey',
			'periodLabel',
			'periodStart',
			'periodEnd',
			'currency',
			'openingBalance',
			'totalExpenses',
			'totalIncome',
			'netChange',
			'closingBalance',
			'balance',
			'tags',
		],
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

function validateFinanceTransactionFrontmatter(
	frontmatter: Partial<FinanceTransactionFrontmatter>,
	categoryTag: 'expense' | 'income',
) {
	const issues = [];

	if (frontmatter.domain !== 'finance') {
		issues.push(createIssue('invalid-finance-domain', 'Finance transaction note must declare domain "finance".'));
	}

	if (!isValidDateString(frontmatter.created)) {
		issues.push(createIssue('invalid-finance-created-date', 'Finance transaction "created" must be a valid date.'));
	}

	if (!isValidDateTimeString(frontmatter.dateTime)) {
		issues.push(createIssue('invalid-finance-datetime', 'Finance transaction "dateTime" must be a valid ISO datetime.'));
	}

	if (!isPositiveNumber(frontmatter.amount)) {
		issues.push(createIssue('invalid-finance-amount', 'Finance transaction "amount" must be a positive number.'));
	}

	if (!isCurrencyCode(frontmatter.currency)) {
		issues.push(createIssue('invalid-finance-currency', 'Finance transaction "currency" must be a 3-letter uppercase code.'));
	}

	if (!isNonEmptyString(frontmatter.description)) {
		issues.push(createIssue('missing-finance-description', 'Finance transaction must have a non-empty description.'));
	}

	if (!isAllowedValue(frontmatter.source, FINANCE_TRANSACTION_SOURCES)) {
		issues.push(
			createIssue(
				'invalid-finance-source',
				`Finance transaction "source" must be one of: ${FINANCE_TRANSACTION_SOURCES.join(', ')}.`,
			),
		);
	}

	if (frontmatter.category !== null && frontmatter.category !== undefined && !isNonEmptyString(frontmatter.category)) {
		issues.push(createIssue('invalid-finance-category', 'Finance transaction "category" must be a non-empty string when present.'));
	}

	if (frontmatter.artifact !== null && frontmatter.artifact !== undefined && !isWikiLink(frontmatter.artifact)) {
		issues.push(createIssue('invalid-finance-artifact-link', 'Finance transaction "artifact" should be a wiki-link like [[Receipt]].', 'warning'));
	}

	if (
		frontmatter.email_msg_id !== undefined
		&& frontmatter.email_msg_id !== null
		&& !isNonEmptyString(frontmatter.email_msg_id)
	) {
		issues.push(createIssue('invalid-finance-email-msg-id', 'Finance transaction "email_msg_id" must be a non-empty string when present.'));
	}

	if (
		frontmatter.email_provider !== undefined
		&& frontmatter.email_provider !== null
		&& !isNonEmptyString(frontmatter.email_provider)
	) {
		issues.push(createIssue('invalid-finance-email-provider', 'Finance transaction "email_provider" must be a non-empty string when present.'));
	}

	if (
		frontmatter.email_mailbox_scope !== undefined
		&& frontmatter.email_mailbox_scope !== null
		&& !isNonEmptyString(frontmatter.email_mailbox_scope)
	) {
		issues.push(createIssue('invalid-finance-email-mailbox-scope', 'Finance transaction "email_mailbox_scope" must be a non-empty string when present.'));
	}

	if (
		frontmatter.duplicate_of !== undefined
		&& frontmatter.duplicate_of !== null
		&& !isWikiLink(frontmatter.duplicate_of)
	) {
		issues.push(createIssue('invalid-finance-duplicate-of', 'Finance transaction "duplicate_of" should be a wiki-link like [[Original Transaction]].', 'warning'));
	}

	if (Array.isArray(frontmatter.tags)) {
		if (!frontmatter.tags.includes('finance')) {
			issues.push(createIssue('missing-finance-tag', 'Finance transaction tags should include "finance".', 'warning'));
		}
		if (!frontmatter.tags.includes(categoryTag)) {
			issues.push(
				createIssue(
					'missing-finance-type-tag',
					`Finance transaction tags should include "${categoryTag}" for this note type.`,
					'warning',
				),
			);
		}
	}

	for (const fiscalField of ['fn', 'fd', 'fp'] as const) {
		const value = frontmatter[fiscalField];
		if (value !== undefined && value !== null && !isNonEmptyString(value)) {
			issues.push(
				createIssue(
					`invalid-finance-${fiscalField}`,
					`Finance transaction "${fiscalField}" must be a non-empty string when present.`,
				),
			);
		}
	}

	if (
		frontmatter.receiptOperationType !== undefined
		&& frontmatter.receiptOperationType !== null
		&& ![1, 2, 3, 4].includes(Number(frontmatter.receiptOperationType))
	) {
		issues.push(
			createIssue(
				'invalid-finance-receipt-operation-type',
				'Finance transaction "receiptOperationType" must be one of 1, 2, 3, or 4 when present.',
			),
		);
	}

	if (frontmatter.ProverkaCheka !== undefined && typeof frontmatter.ProverkaCheka !== 'boolean') {
		issues.push(createIssue('invalid-finance-proverkacheka-flag', 'Finance transaction "ProverkaCheka" must be a boolean when present.'));
	}

	return issues;
}

function validateFinanceReportFrontmatter(frontmatter: Partial<FinanceReportFrontmatter>) {
	const issues = [];

	if (frontmatter.domain !== 'finance') {
		issues.push(createIssue('invalid-finance-report-domain', 'Finance report note must declare domain "finance".'));
	}

	if (!isValidDateString(frontmatter.created)) {
		issues.push(createIssue('invalid-finance-report-created-date', 'Finance report "created" must be a valid date.'));
	}

	if (!isAllowedValue(frontmatter.periodKind, FINANCE_REPORT_PERIOD_KINDS)) {
		issues.push(
			createIssue(
				'invalid-finance-report-period-kind',
				`Finance report "periodKind" must be one of: ${FINANCE_REPORT_PERIOD_KINDS.join(', ')}.`,
			),
		);
	}

	if (!isNonEmptyString(frontmatter.periodKey)) {
		issues.push(createIssue('missing-finance-report-period-key', 'Finance report must have a non-empty "periodKey".'));
	}

	if (!isNonEmptyString(frontmatter.periodLabel)) {
		issues.push(createIssue('missing-finance-report-period-label', 'Finance report must have a non-empty "periodLabel".'));
	}

	const hasValidPeriodStart = isValidDateString(frontmatter.periodStart);
	const hasValidPeriodEnd = isValidDateString(frontmatter.periodEnd);
	if (!hasValidPeriodStart) {
		issues.push(createIssue('invalid-finance-report-period-start', 'Finance report "periodStart" must be a valid date.'));
	}
	if (!hasValidPeriodEnd) {
		issues.push(createIssue('invalid-finance-report-period-end', 'Finance report "periodEnd" must be a valid date.'));
	}
	if (
		hasValidPeriodStart
		&& hasValidPeriodEnd
		&& new Date(String(frontmatter.periodStart)).getTime() > new Date(String(frontmatter.periodEnd)).getTime()
	) {
		issues.push(createIssue('invalid-finance-report-period-range', 'Finance report "periodStart" must not be after "periodEnd".'));
	}

	if (!isCurrencyCode(frontmatter.currency)) {
		issues.push(createIssue('invalid-finance-report-currency', 'Finance report "currency" must be a 3-letter uppercase code.'));
	}

	const numericFields: Array<[keyof FinanceReportFrontmatter, string]> = [
		['openingBalance', 'openingBalance'],
		['totalExpenses', 'totalExpenses'],
		['totalIncome', 'totalIncome'],
		['netChange', 'netChange'],
		['closingBalance', 'closingBalance'],
		['balance', 'balance'],
	];
	for (const [field, label] of numericFields) {
		if (!isFiniteNumber(frontmatter[field])) {
			issues.push(createIssue(`invalid-finance-report-${label}`, `Finance report "${label}" must be a finite number.`));
		}
	}

	if (isFiniteNumber(frontmatter.totalExpenses) && Number(frontmatter.totalExpenses) < 0) {
		issues.push(createIssue('invalid-finance-report-total-expenses', 'Finance report "totalExpenses" must not be negative.'));
	}

	if (isFiniteNumber(frontmatter.totalIncome) && Number(frontmatter.totalIncome) < 0) {
		issues.push(createIssue('invalid-finance-report-total-income', 'Finance report "totalIncome" must not be negative.'));
	}

	if (frontmatter.budget !== undefined && frontmatter.budget !== null) {
		if (!isFiniteNumber(frontmatter.budget) || Number(frontmatter.budget) < 0) {
			issues.push(createIssue('invalid-finance-report-budget', 'Finance report "budget" must be a non-negative number when present.'));
		}
	}

	if (
		isFiniteNumber(frontmatter.totalIncome)
		&& isFiniteNumber(frontmatter.totalExpenses)
		&& isFiniteNumber(frontmatter.netChange)
		&& !isApproximatelyEqual(
			Number(frontmatter.netChange),
			Number(frontmatter.totalIncome) - Number(frontmatter.totalExpenses),
		)
	) {
		issues.push(
			createIssue(
				'inconsistent-finance-report-net-change',
				'Finance report "netChange" should equal totalIncome - totalExpenses.',
				'warning',
			),
		);
	}

	if (
		isFiniteNumber(frontmatter.openingBalance)
		&& isFiniteNumber(frontmatter.netChange)
		&& isFiniteNumber(frontmatter.closingBalance)
		&& !isApproximatelyEqual(
			Number(frontmatter.closingBalance),
			Number(frontmatter.openingBalance) + Number(frontmatter.netChange),
		)
	) {
		issues.push(
			createIssue(
				'inconsistent-finance-report-closing-balance',
				'Finance report "closingBalance" should equal openingBalance + netChange.',
				'warning',
			),
		);
	}

	if (
		isFiniteNumber(frontmatter.closingBalance)
		&& isFiniteNumber(frontmatter.balance)
		&& !isApproximatelyEqual(Number(frontmatter.balance), Number(frontmatter.closingBalance))
	) {
		issues.push(
			createIssue(
				'inconsistent-finance-report-balance',
				'Finance report "balance" should match "closingBalance".',
				'warning',
			),
		);
	}

	if (Array.isArray(frontmatter.tags)) {
		if (!frontmatter.tags.includes('finance')) {
			issues.push(createIssue('missing-finance-report-tag', 'Finance report tags should include "finance".', 'warning'));
		}
		if (!frontmatter.tags.includes('report')) {
			issues.push(createIssue('missing-finance-report-kind-tag', 'Finance report tags should include "report".', 'warning'));
		}
	}

	return issues;
}

function createIssue(code: string, message: string, severity: 'error' | 'warning' = 'error') {
	return { code, message, severity };
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isCurrencyCode(value: unknown): boolean {
	return typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim());
}

function isValidDateString(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}

function isValidDateTimeString(value: unknown): boolean {
	return isValidDateString(value) && String(value).includes('T');
}

function isAllowedValue<T extends readonly string[]>(value: unknown, allowedValues: T): boolean {
	return typeof value === 'string' && (allowedValues as readonly string[]).includes(value);
}

function isWikiLink(value: unknown): boolean {
	return typeof value === 'string' && /^\[\[[^[\]]+\]\]$/.test(value.trim());
}

function isApproximatelyEqual(left: number, right: number, epsilon = 0.01): boolean {
	return Math.abs(left - right) <= epsilon;
}

function renderFinanceTransactionTemplate(
	ctx: TemplateContext<FinanceTransactionFrontmatter>,
	categoryTag: 'expense' | 'income',
): string {
	const frontmatter = ctx.frontmatter;
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
		email_msg_id: frontmatter.email_msg_id,
		email_provider: frontmatter.email_provider,
		email_mailbox_scope: frontmatter.email_mailbox_scope,
		duplicate_of: frontmatter.duplicate_of,
		fn: frontmatter.fn,
		fd: frontmatter.fd,
		fp: frontmatter.fp,
		receiptOperationType: frontmatter.receiptOperationType,
		ProverkaCheka: frontmatter.ProverkaCheka,
	};

	const body: string[] = [];

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
