import { App, TFile, TFolder, normalizePath } from 'obsidian';
import {
	TransactionData,
	PeriodReport,
	CategorySummary,
	FinanceContextSummary,
	FinanceReportSection,
	ReportPeriodDescriptor,
	ReportPeriodKind,
	ReportBudgetSummary,
	ReportBudgetAlertLevel,
	ReportBudgetAlertState,
} from '../types';
import { ExpenseManagerSettings } from '../settings';
import { DashboardContributionMode } from '../settings';
import { IParaCoreApi, RegisteredParaDomain } from '../integrations/para-core/types';
import { getPluginLogger } from '../utils/plugin-debug-log';
import { 
	generateFrontmatter, 
	generateContentBody, 
	parseFrontmatter,
	parseYamlFrontmatter,
	parseDetailsFromContent,
	generateFilename 
} from '../utils/frontmatter';
import {
	createCustomPeriodDescriptor,
	formatDateKey,
	formatPeriodTitle,
} from '../utils/report-periods';

export class DuplicateTransactionError extends Error {
	constructor() {
		super('Duplicate transaction detected');
		this.name = 'DuplicateTransactionError';
	}
}

const MANAGED_REPORT_OWNER = 'expense-manager';
const REPORT_ENGINE_DATAVIEWJS = 'dataviewjs';
const DEFAULT_REPORT_TEMPLATE = 'default';
const REPORT_CHART_COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#1d4ed8', '#9333ea', '#ca8a04'];

type ReportTableCell = string | HTMLElement;

interface ReportRenderConfig {
	file: TFile;
	descriptor: ReportPeriodDescriptor;
	currency: string;
	transactionsRoot: string;
	filterProject: string;
	filterArea: string;
	filterTypes: TransactionData['type'][];
	budgetLimit: number | null;
}

interface ReportRenderState {
	config: ReportRenderConfig;
	report: PeriodReport;
	filterSummary: string[];
}

interface DashboardRenderOptions {
	mode: DashboardContributionMode;
	transactionsRoot: string;
	reportsRoot: string;
}

interface DashboardMonthlyState {
	monthDate: Date;
	report: Record<string, unknown> | null;
	expenseCategories: CategorySummary[];
	totalExpenses: number;
	totalIncome: number;
	openingBalance: number;
	closingBalance: number;
}

interface DashboardYearlyState {
	year: number;
	expenses: number[];
	incomes: number[];
	warningMonths: number;
	forecastMonths: number;
	criticalMonths: number;
}

export class ExpenseService {
	private app: App;
	private settings: ExpenseManagerSettings;
	private paraCoreApi: IParaCoreApi | null;
	private financeDomain: RegisteredParaDomain | null;
	private reportRenderStateCache = new Map<string, Promise<ReportRenderState>>();

	constructor(
		app: App,
		settings: ExpenseManagerSettings,
		paraCoreApi?: IParaCoreApi | null,
		financeDomain?: RegisteredParaDomain | null,
	) {
		this.app = app;
		this.settings = settings;
		this.paraCoreApi = paraCoreApi || null;
		this.financeDomain = financeDomain || null;
	}
	/**
	 * Create a new transaction file
	 */
	async createTransaction(data: TransactionData): Promise<TFile> {
		await this.validateLinkedContext(data);
		const isDuplicate = await this.isDuplicateTransaction(
			data.fn,
			data.fd,
			data.fp,
			data.dateTime,
			data.amount,
			data.type,
		);
		if (isDuplicate) {
			throw new DuplicateTransactionError();
		}
		const dataWithArtifact = await this.attachArtifactIfNeeded(data);

		if (this.canUseParaCoreRecords()) {
			return this.createTransactionViaParaCore(dataWithArtifact);
		}

		// Ensure expense folder exists
		await this.ensureExpenseFolder();

		// Generate filename and content
		const filename = generateFilename(dataWithArtifact);
		const folderPath = await this.ensureFolderPath(this.getTransactionFolderPath(dataWithArtifact.dateTime));
		const filepath = `${folderPath}/${filename}`;
		
		const frontmatter = generateFrontmatter(dataWithArtifact);
		const contentBody = generateContentBody(dataWithArtifact);
		const fullContent = frontmatter + contentBody;

		// Create the file
		const file = await this.app.vault.create(filepath, fullContent);
		
		return file;
	}

	private async attachArtifactIfNeeded(data: TransactionData): Promise<TransactionData> {
		if (data.artifact || !data.artifactBytes || !data.artifactFileName) {
			return data;
		}

		if (this.paraCoreApi && this.financeDomain) {
			const savedAttachment = await this.paraCoreApi.saveAttachment({
				source: data.artifactBytes,
				fileName: data.artifactFileName,
				scope: this.financeDomain.id,
				placementDate: data.dateTime,
			});

			return {
				...data,
				artifact: `[[${savedAttachment.path}]]`,
				artifactBytes: undefined,
				artifactFileName: undefined,
				artifactMimeType: undefined,
			};
		}

		const folderPath = await this.ensureFolderPath(this.getArtifactsFolderPath(data.dateTime));
		const sanitizedName = data.artifactFileName.replace(/[\\/:*?"<>|]/g, '-');
		const storedName = this.buildArtifactFileName(data.dateTime, sanitizedName);
		const artifactPath = await this.getAvailableArtifactPath(folderPath, storedName);
		await this.app.vault.createBinary(artifactPath, data.artifactBytes);

		return {
			...data,
			artifact: `[[${artifactPath}]]`,
			artifactBytes: undefined,
			artifactFileName: undefined,
			artifactMimeType: undefined,
		};
	}

	/**
	 * Get all transactions from vault
	 */
	async getAllTransactions(): Promise<TransactionData[]> {
		const files = this.getTransactionFiles();
		const transactions: TransactionData[] = [];

		for (const file of files) {
			if (!(file instanceof TFile)) continue;
			
			try {
				const transaction = await this.parseTransactionFile(file);
				if (transaction) {
					transactions.push(transaction);
				}
			} catch (error) {
				getPluginLogger().error(`Error parsing file ${file.path}`, error);
			}
		}

		// Sort by date descending
		transactions.sort((a, b) => 
			new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime()
		);

		return transactions;
	}

	/**
	 * Get transactions within a date range
	 */
	async getTransactionsByPeriod(startDate: Date, endDate: Date): Promise<TransactionData[]> {
		const allTransactions = await this.getAllTransactions();
		
		return allTransactions.filter(t => {
			const tDate = new Date(t.dateTime);
			return tDate >= startDate && tDate <= endDate;
		});
	}

	/**
	 * Parse a transaction file into TransactionData
	 */
	async parseTransactionFile(file: TFile): Promise<TransactionData | null> {
		try {
			const content = await this.app.vault.cachedRead(file);
			const frontmatter = parseYamlFrontmatter(content);
			
			if (!frontmatter || !frontmatter.type || !frontmatter.amount) {
				return null;
			}

			const details = parseDetailsFromContent(content);

			return {
				id: file.path,
				type: this.normalizeTransactionType(frontmatter.type as string),
				amount: Number(frontmatter.amount),
				currency: (frontmatter.currency as string) || 'RUB',
				dateTime: (frontmatter.dateTime as string) || (frontmatter.date as string) || '',
				description: (frontmatter.description as string) || (frontmatter.comment as string) || '',
				area: frontmatter.area as string | undefined,
				project: frontmatter.project as string | undefined,
				tags: (frontmatter.tags as string[]) || [],
				category: frontmatter.category as string,
				details: details,
				artifact: frontmatter.artifact as string | undefined,
				source: (frontmatter.source as any) || 'manual',
				fd: frontmatter.fd as string | undefined,
				fn: frontmatter.fn as string | undefined,
				fp: frontmatter.fp as string | undefined,
				file: file
			};
		} catch (error) {
			getPluginLogger().error(`Error parsing transaction file ${file.path}`, error);
			return null;
		}
	}

	/**
	 * Generate period report
	 */
	async generatePeriodReport(startDate: Date, endDate: Date): Promise<PeriodReport> {
		const descriptor = createCustomPeriodDescriptor(startDate, endDate);
		const allTransactions = await this.getAllTransactions();
		const budget = await this.getExistingBudgetForDescriptor(descriptor);
		return this.buildPeriodReportFromTransactions(allTransactions, descriptor, budget);
	}

	buildPeriodReportFromTransactions(
		allTransactions: TransactionData[],
		descriptor: ReportPeriodDescriptor,
		budgetLimit?: number | null,
	): PeriodReport {
		const sortedTransactions = allTransactions
			.slice()
			.sort((left, right) => new Date(left.dateTime).getTime() - new Date(right.dateTime).getTime());
		const openingBalance = this.calculateOpeningBalance(sortedTransactions, descriptor.startDate);
		const transactions = sortedTransactions.filter((transaction) => {
			const timestamp = new Date(transaction.dateTime).getTime();
			return timestamp >= descriptor.startDate.getTime() && timestamp <= descriptor.endDate.getTime();
		});

		let totalExpenses = 0;
		let totalIncome = 0;
		const combinedCategoryMap = new Map<string, { total: number; count: number }>();
		const expenseCategoryMap = new Map<string, { total: number; count: number }>();
		const incomeCategoryMap = new Map<string, { total: number; count: number }>();

		for (const transaction of transactions) {
			const category = transaction.category || 'uncategorized';
			this.bumpCategory(combinedCategoryMap, category, transaction.amount);
			if (transaction.type === 'expense') {
				totalExpenses += transaction.amount;
				this.bumpCategory(expenseCategoryMap, category, transaction.amount);
			} else {
				totalIncome += transaction.amount;
				this.bumpCategory(incomeCategoryMap, category, transaction.amount);
			}
		}

		const netChange = totalIncome - totalExpenses;
		const closingBalance = openingBalance + netChange;

		return {
			periodKind: descriptor.kind,
			periodKey: descriptor.key,
			periodLabel: descriptor.label,
			startDate: descriptor.startDate,
			endDate: descriptor.endDate,
			totalExpenses,
			totalIncome,
			netChange,
			openingBalance,
			closingBalance,
			balance: closingBalance,
			budget: this.buildBudgetSummary(budgetLimit ?? null, totalExpenses, descriptor),
			transactions: transactions
				.slice()
				.sort((left, right) => new Date(right.dateTime).getTime() - new Date(left.dateTime).getTime()),
			byCategory: this.finalizeCategorySummary(combinedCategoryMap, totalExpenses + totalIncome),
			expenseByCategory: this.finalizeCategorySummary(expenseCategoryMap, totalExpenses),
			incomeByCategory: this.finalizeCategorySummary(incomeCategoryMap, totalIncome),
		};
	}

	/**
	 * Update an existing transaction
	 */
	async updateTransaction(file: TFile, data: Partial<TransactionData>): Promise<void> {
		const current = await this.parseTransactionFile(file);
		if (!current) {
			throw new Error('Could not parse existing transaction');
		}

		const updated = { ...current, ...data };
		await this.validateLinkedContext(updated);
		const frontmatter = generateFrontmatter(updated);
		const contentBody = generateContentBody(updated);
		const fullContent = frontmatter + contentBody;

		await this.app.vault.modify(file, fullContent);
	}

	/**
	 * Delete a transaction
	 */
	async deleteTransaction(file: TFile): Promise<void> {
		await this.app.vault.delete(file);
	}

	/**
	 * Ensure expense folder exists
	 */
	private async ensureExpenseFolder(): Promise<void> {
		await this.ensureFolderPath(this.settings.expenseFolder);
	}

	/**
	 * Get unique tags from all transactions
	 */
	async getAllTags(): Promise<string[]> {
		const transactions = await this.getAllTransactions();
		const tagSet = new Set<string>();

		for (const t of transactions) {
			for (const tag of t.tags) {
				tagSet.add(tag);
			}
		}

		return Array.from(tagSet).sort();
	}

	/**
	 * Get transactions by category
	 */
	async getTransactionsByCategory(category: string): Promise<TransactionData[]> {
		const allTransactions = await this.getAllTransactions();
		
		return allTransactions.filter(t => 
			t.category === category || t.tags.includes(category)
		);
	}

	async getProjectSummary(file: TFile): Promise<FinanceContextSummary> {
		return this.getContextSummary('project', file);
	}

	async getAreaSummary(file: TFile): Promise<FinanceContextSummary> {
		return this.getContextSummary('area', file);
	}

	/**
	 * Check if a transaction with same fiscal data already exists
	 */
	async isDuplicateTransaction(
		fn: string | undefined,
		fd: string | undefined,
		fp: string | undefined,
		dateTime: string,
		amount: number,
		type: TransactionData['type'],
	): Promise<boolean> {
		const allTransactions = await this.getAllTransactions();
		const transactionTime = new Date(dateTime).getTime();

		for (const t of allTransactions) {
			const fnMatch = fn && t.fn && t.fn === fn;
			const fdMatch = fd && t.fd && t.fd === fd;
			const fpMatch = fp && t.fp && t.fp === fp;
			if (fnMatch || fdMatch || fpMatch) {
				return true;
			}

			if (t.type !== type || Math.abs(t.amount - amount) > 0.0001) {
				continue;
			}

			const existingTime = new Date(t.dateTime).getTime();
			const timeDiffMs = Math.abs(existingTime - transactionTime);
			if (timeDiffMs <= 60 * 1000) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Generate markdown content for period report
	 */
	generateReportMarkdown(report: PeriodReport, generatedAt = new Date().toISOString()): string {
		const formatDate = (date: Date): string => formatDateKey(date);
		const currency = this.settings.defaultCurrency;
		const reportId = this.buildManagedReportId({
			kind: report.periodKind,
			key: report.periodKey,
			startDate: report.startDate,
			endDate: report.endDate,
		});
		const transactionsRoot = this.getTransactionsRootPath();

		const frontmatterLines = [
			'---',
			'type: "finance-report"',
			`reportOwner: "${MANAGED_REPORT_OWNER}"`,
			`reportEngine: "${REPORT_ENGINE_DATAVIEWJS}"`,
			`reportId: "${reportId}"`,
			`reportTemplate: "${DEFAULT_REPORT_TEMPLATE}"`,
			`periodKind: "${report.periodKind}"`,
			`periodKey: "${report.periodKey}"`,
			`periodLabel: "${report.periodLabel.replace(/"/g, '\\"')}"`,
			`periodStart: ${formatDate(report.startDate)}`,
			`periodEnd: ${formatDate(report.endDate)}`,
			`generatedAt: ${generatedAt}`,
			`currency: "${currency}"`,
			`transactionsRoot: "${transactionsRoot.replace(/"/g, '\\"')}"`,
			'filterProject: ""',
			'filterArea: ""',
			'tags: ["finance","report"]',
			'filterTypes: ["expense","income"]',
			`openingBalance: ${report.openingBalance.toFixed(2)}`,
			`totalExpenses: ${report.totalExpenses.toFixed(2)}`,
			`totalIncome: ${report.totalIncome.toFixed(2)}`,
			`netChange: ${report.netChange.toFixed(2)}`,
			`closingBalance: ${report.closingBalance.toFixed(2)}`,
			`balance: ${report.balance.toFixed(2)}`,
			...(report.budget ? [`budget: ${report.budget.limit.toFixed(2)}`] : []),
			...(report.budget ? [`budget_spent: ${report.budget.spent.toFixed(2)}`] : []),
			...(report.budget ? [`budget_remaining: ${report.budget.remaining.toFixed(2)}`] : []),
			...(report.budget && report.budget.usagePercentage !== null ? [`budget_usage_percentage: ${report.budget.usagePercentage.toFixed(2)}`] : []),
			...(report.budget ? [`budget_warning_threshold_percentage: ${report.budget.warningThresholdPercentage.toFixed(2)}`] : []),
			...(report.budget && report.budget.projectedSpent !== null ? [`budget_projected_spent: ${report.budget.projectedSpent.toFixed(2)}`] : []),
			...(report.budget && report.budget.projectedDelta !== null ? [`budget_projected_delta: ${report.budget.projectedDelta.toFixed(2)}`] : []),
			...(report.budget ? [`budget_alert_level: "${report.budget.alertLevel}"`] : []),
			...(report.budget ? [`budget_alerts_enabled: ${report.budget.alertsEnabled}`] : []),
			...(report.budget ? [`budget_forecast_enabled: ${report.budget.forecastEnabled}`] : []),
			...(report.budget ? [`budget_alert_state_warning_sent: ${report.budget.alertState.sentWarning}`] : []),
			...(report.budget ? [`budget_alert_state_forecast_sent: ${report.budget.alertState.sentForecast}`] : []),
			...(report.budget ? [`budget_alert_state_critical_sent: ${report.budget.alertState.sentCritical}`] : []),
			...(report.budget?.alertState.lastAlertAt ? [`budget_alert_state_last_alert_at: ${report.budget.alertState.lastAlertAt}`] : []),
			'---',
			'',
		];
		const bodyLines = [
			'> This finance report stays compact and renders live tables through DataviewJS.',
			'> Duplicate the note, set `reportOwner: "user"`, assign a unique `reportId`, and adjust `periodStart`, `periodEnd`, `filterProject`, or `filterArea` to create a custom report.',
			'',
			'## Snapshot',
			'',
			`- Period: ${report.periodLabel}`,
			`- Opening balance: ${report.openingBalance.toFixed(2)} ${currency}`,
			`- Income: ${report.totalIncome.toFixed(2)} ${currency}`,
			`- Expenses: ${report.totalExpenses.toFixed(2)} ${currency}`,
			`- Closing balance: ${report.closingBalance.toFixed(2)} ${currency}`,
			...(report.budget
				? [
					`- Budget: ${report.budget.limit.toFixed(2)} ${currency}`,
					`- Budget remaining: ${report.budget.remaining.toFixed(2)} ${currency}`,
					`- Budget alert: ${report.budget.alertLevel}`,
				]
				: []),
			'',
			'> Enable the Dataview plugin to render the live report block below.',
			'',
			...this.buildReportDataviewTemplate(),
			'',
		];

		return `${frontmatterLines.join('\n')}${bodyLines.join('\n')}`;
	}

	/**
	 * Save report as markdown file
	 */
	async saveReportAsFile(report: PeriodReport): Promise<TFile> {
		return this.upsertReportFile(report);
	}

	clearReportRenderCache(filePath?: string): void {
		if (filePath) {
			this.reportRenderStateCache.delete(normalizePath(filePath));
			return;
		}

		this.reportRenderStateCache.clear();
	}

	async renderReportSection(
		section: FinanceReportSection,
		container: HTMLElement,
		reportFilePath: string,
	): Promise<void> {
		container.replaceChildren();

		try {
			const state = await this.getReportRenderState(reportFilePath);
			if (section === 'summary') {
				this.renderReportSummarySection(container, state);
				return;
			}
			if (section === 'expense-categories') {
				this.renderCategoryTableSection(container, state.report.expenseByCategory, state.config.currency, 'No expenses in this period.');
				return;
			}
			if (section === 'income-categories') {
				this.renderCategoryTableSection(container, state.report.incomeByCategory, state.config.currency, 'No income in this period.');
				return;
			}
			if (section === 'expense-chart') {
				this.renderPieChartSection(container, state.report.expenseByCategory, state.config.currency, 'Expense breakdown', 'No expenses in this period.');
				return;
			}
			if (section === 'income-chart') {
				this.renderPieChartSection(container, state.report.incomeByCategory, state.config.currency, 'Income breakdown', 'No income in this period.');
				return;
			}
			if (section === 'trend') {
				this.renderTrendSection(container, state);
				return;
			}
			this.renderTransactionsSection(container, state);
		} catch (error) {
			container.createEl('div', {
				text: `Unable to render report section: ${(error as Error).message}`,
			});
			getPluginLogger().error('Expense Manager report render error', error);
		}
	}

	async renderFinanceDashboard(
		container: HTMLElement,
		options: DashboardRenderOptions,
	): Promise<void> {
		const state = {
			monthDate: this.getMonthStart(new Date()),
			year: new Date().getFullYear(),
		};

		const render = async (): Promise<void> => {
			container.replaceChildren();

			try {
				const [monthlyState, yearlyState] = await Promise.all([
					this.buildDashboardMonthlyState(options, state.monthDate),
					this.buildDashboardYearlyState(options, state.year),
				]);

				if (options.mode === 'interactive') {
					this.renderDashboardMonthSection(container, monthlyState, options.mode, state, render);
					this.renderDashboardYearSection(container, yearlyState, options.mode, state, render);
					return;
				}

				this.renderDashboardMonthSection(container, monthlyState, options.mode, state, render);
				this.renderDashboardYearSection(container, yearlyState, options.mode, state, render);
			} catch (error) {
				container.createEl('div', {
					text: `Unable to render finance dashboard: ${(error as Error).message}`,
				});
				getPluginLogger().error('Expense Manager dashboard render error', error);
			}
		};

		await render();
	}

	private async getReportRenderState(reportFilePath: string): Promise<ReportRenderState> {
		const normalizedPath = normalizePath(reportFilePath);
		const cached = this.reportRenderStateCache.get(normalizedPath);
		if (cached) {
			return cached;
		}

		const pending = this.buildReportRenderState(normalizedPath).catch((error) => {
			this.reportRenderStateCache.delete(normalizedPath);
			throw error;
		});
		this.reportRenderStateCache.set(normalizedPath, pending);
		return pending;
	}

	private async buildReportRenderState(reportFilePath: string): Promise<ReportRenderState> {
		const abstractFile = this.app.vault.getAbstractFileByPath(reportFilePath);
		if (!(abstractFile instanceof TFile)) {
			throw new Error(`Report file not found: ${reportFilePath}`);
		}

		const content = await this.app.vault.cachedRead(abstractFile);
		const frontmatter = parseYamlFrontmatter(content);
		if (!frontmatter) {
			throw new Error('Report note is missing frontmatter');
		}

		const descriptor = this.readReportDescriptor(frontmatter);
		const config = this.readReportRenderConfig(abstractFile, frontmatter, descriptor);
		const allTransactions = await this.getAllTransactions();
		const scopedTransactions = allTransactions.filter((transaction) => this.matchesReportRenderConfig(transaction, config));
		const report = this.hydrateReportWithBudgetState(
			this.buildPeriodReportFromTransactions(scopedTransactions, descriptor, config.budgetLimit),
			config.budgetLimit,
			await this.readReportBudgetAlertState(abstractFile),
		);

		return {
			config,
			report,
			filterSummary: [
				...(config.filterProject ? [`Project: ${config.filterProject}`] : []),
				...(config.filterArea ? [`Area: ${config.filterArea}`] : []),
			],
		};
	}

	private readReportDescriptor(
		frontmatter: Record<string, unknown>,
	): ReportPeriodDescriptor {
		const rawStart = typeof frontmatter.periodStart === 'string'
			? frontmatter.periodStart
			: typeof frontmatter.period === 'string'
				? String(frontmatter.period).split(' to ')[0]?.trim() ?? ''
				: '';
		const rawEnd = typeof frontmatter.periodEnd === 'string'
			? frontmatter.periodEnd
			: typeof frontmatter.period === 'string'
				? String(frontmatter.period).split(' to ')[1]?.trim() ?? ''
				: '';

		if (!rawStart || !rawEnd) {
			throw new Error('Report periodStart/periodEnd is missing');
		}

		const startDate = new Date(rawStart);
		const endDate = new Date(rawEnd);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			throw new Error('Report period dates are invalid');
		}

		const fallbackDescriptor = createCustomPeriodDescriptor(startDate, endDate);
		const kind = typeof frontmatter.periodKind === 'string'
			? frontmatter.periodKind as ReportPeriodKind
			: fallbackDescriptor.kind;
		return {
			kind,
			key: typeof frontmatter.periodKey === 'string' ? frontmatter.periodKey : fallbackDescriptor.key,
			label: typeof frontmatter.periodLabel === 'string' ? frontmatter.periodLabel : fallbackDescriptor.label,
			startDate: fallbackDescriptor.startDate,
			endDate: fallbackDescriptor.endDate,
		};
	}

	private readReportRenderConfig(
		file: TFile,
		frontmatter: Record<string, unknown>,
		descriptor: ReportPeriodDescriptor,
	): ReportRenderConfig {
		const filterTypes = this.readReportFilterTypes(frontmatter.filterTypes);
		return {
			file,
			descriptor,
			currency: typeof frontmatter.currency === 'string' ? frontmatter.currency : this.settings.defaultCurrency,
			transactionsRoot: typeof frontmatter.transactionsRoot === 'string'
				? normalizePath(frontmatter.transactionsRoot)
				: normalizePath(this.getTransactionsRootPath()),
			filterProject: this.extractLinkPath(typeof frontmatter.filterProject === 'string' ? frontmatter.filterProject : '') ?? '',
			filterArea: this.extractLinkPath(typeof frontmatter.filterArea === 'string' ? frontmatter.filterArea : '') ?? '',
			filterTypes,
			budgetLimit: this.readBudgetValue(frontmatter.budget),
		};
	}

	private readReportFilterTypes(value: unknown): TransactionData['type'][] {
		const rawValues = Array.isArray(value) ? value : ['expense', 'income'];
		const normalized = rawValues
			.map((entry) => this.normalizeReportFilterType(entry))
			.filter((entry): entry is TransactionData['type'] => entry !== null);
		return normalized.length > 0 ? normalized : ['expense', 'income'];
	}

	private normalizeReportFilterType(value: unknown): TransactionData['type'] | null {
		const raw = String(value ?? '').trim();
		if (raw === 'expense' || raw === 'finance-expense') {
			return 'expense';
		}
		if (raw === 'income' || raw === 'finance-income') {
			return 'income';
		}
		return null;
	}

	private readBudgetValue(value: unknown): number | null {
		if (value === null || value === undefined || value === '') {
			return null;
		}

		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	private matchesReportRenderConfig(
		transaction: TransactionData,
		config: ReportRenderConfig,
	): boolean {
		if (!config.filterTypes.includes(transaction.type)) {
			return false;
		}

		const filePath = transaction.file?.path ? normalizePath(transaction.file.path) : '';
		const rootPrefix = `${config.transactionsRoot}/`;
		if (filePath && filePath !== config.transactionsRoot && !filePath.startsWith(rootPrefix)) {
			return false;
		}

		if (config.filterProject) {
			const projectPath = this.extractLinkPath(transaction.project);
			if (projectPath !== config.filterProject) {
				return false;
			}
		}

		if (config.filterArea) {
			const areaPath = this.extractLinkPath(transaction.area);
			if (areaPath !== config.filterArea) {
				return false;
			}
		}

		return true;
	}

	private renderReportSummarySection(container: HTMLElement, state: ReportRenderState): void {
		if (state.filterSummary.length > 0) {
			container.createEl('div', {
				text: state.filterSummary.join(' | '),
				attr: {
					style: 'margin-bottom: 12px; color: var(--text-muted); font-size: 0.9em;',
				},
			});
		}

		const metricsGrid = container.createDiv();
		metricsGrid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:12px;';
		this.appendMetricCard(metricsGrid, 'Opening', this.formatMoney(state.report.openingBalance, state.config.currency));
		this.appendMetricCard(metricsGrid, 'Income', this.formatMoney(state.report.totalIncome, state.config.currency));
		this.appendMetricCard(metricsGrid, 'Expenses', this.formatMoney(state.report.totalExpenses, state.config.currency));
		this.appendMetricCard(metricsGrid, 'Closing', this.formatMoney(state.report.closingBalance, state.config.currency));
		this.appendMetricCard(metricsGrid, 'Transactions', String(state.report.transactions.length));
		this.appendMetricCard(metricsGrid, 'Net change', this.formatMoney(state.report.netChange, state.config.currency));

		if (!state.report.budget) {
			return;
		}

		const budgetGrid = container.createDiv();
		budgetGrid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px;';
		this.appendMetricCard(budgetGrid, 'Budget', this.formatMoney(state.report.budget.limit, state.config.currency));
		this.appendMetricCard(budgetGrid, 'Budget remaining', this.formatMoney(state.report.budget.remaining, state.config.currency));
		this.appendMetricCard(
			budgetGrid,
			'Used',
			state.report.budget.usagePercentage === null ? '-' : `${state.report.budget.usagePercentage.toFixed(1)}%`,
		);
		this.appendMetricCard(budgetGrid, 'Alert', state.report.budget.alertLevel);
	}

	private appendMetricCard(container: HTMLElement, label: string, value: string): void {
		const card = container.createDiv();
		card.style.cssText = 'padding:12px 14px; border:1px solid var(--background-modifier-border); border-radius:16px; background:var(--background-secondary);';
		card.createEl('div', {
			text: label,
			attr: {
				style: 'font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:6px;',
			},
		});
		card.createEl('div', {
			text: value,
			attr: {
				style: 'font-size:18px; font-weight:600; color:var(--text-normal);',
			},
		});
	}

	private renderCategoryTableSection(
		container: HTMLElement,
		categories: CategorySummary[],
		currency: string,
		emptyText: string,
	): void {
		if (categories.length === 0) {
			container.createEl('div', { text: emptyText });
			return;
		}

		this.renderTable(
			container,
			['Category', 'Amount', '%', 'Count'],
			categories.map((category) => [
				category.category,
				this.formatMoney(category.total, currency),
				`${category.percentage.toFixed(1)}%`,
				String(category.count),
			]),
		);
	}

	private renderPieChartSection(
		container: HTMLElement,
		categories: CategorySummary[],
		currency: string,
		title: string,
		emptyText: string,
	): void {
		if (categories.length === 0) {
			container.createEl('div', { text: emptyText });
			return;
		}

		const wrapper = container.createDiv();
		wrapper.innerHTML = `<div style="padding:16px; border:1px solid var(--background-modifier-border); border-radius:20px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 92%, white 8%), var(--background-primary));"><div style="font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;">${title}</div><div style="display:grid; grid-template-columns:minmax(200px, 240px) 1fr; gap:18px; align-items:center;"><div style="display:flex; justify-content:center;">${this.buildPieChartSvg(categories, 'Total')}</div><div>${this.buildPieChartLegend(categories, currency)}</div></div></div>`;
	}

	private renderTrendSection(container: HTMLElement, state: ReportRenderState): void {
		if (state.report.periodKind !== 'year') {
			container.createEl('div', { text: 'Monthly trend is available for yearly reports.' });
			return;
		}

		const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const expenses = labels.map(() => 0);
		const incomes = labels.map(() => 0);

		for (const transaction of state.report.transactions) {
			const monthIndex = new Date(transaction.dateTime).getMonth();
			if (monthIndex < 0 || monthIndex > 11) {
				continue;
			}

			if (transaction.type === 'income') {
				incomes[monthIndex] += transaction.amount;
			} else {
				expenses[monthIndex] += transaction.amount;
			}
		}

		const wrapper = container.createDiv();
		const yearLabel = String(state.report.startDate.getFullYear());
		wrapper.innerHTML = `<div style="padding:16px; border:1px solid var(--background-modifier-border); border-radius:20px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 92%, white 8%), var(--background-primary));"><div style="font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;">${yearLabel} monthly trend</div><div style="overflow-x:auto;">${this.buildBarTrendChartSvg(labels, expenses, incomes)}${this.buildBarTrendLegend()}</div></div>`;
	}

	private renderTransactionsSection(container: HTMLElement, state: ReportRenderState): void {
		if (state.report.transactions.length === 0) {
			container.createEl('div', { text: 'No transactions match the current report filters.' });
			return;
		}

		this.renderTable(
			container,
			['File', 'Date', 'Type', 'Amount', 'Category', 'Project', 'Area', 'Description'],
			state.report.transactions.map((transaction) => [
				this.createFileLinkCell(transaction.file ?? null, transaction.file?.basename ?? transaction.description ?? 'Open'),
				transaction.dateTime,
				transaction.type,
				this.formatMoney(transaction.amount, transaction.currency),
				transaction.category || 'uncategorized',
				this.createReferenceCell(transaction.project),
				this.createReferenceCell(transaction.area),
				transaction.description,
			]),
		);
	}

	private renderTable(container: HTMLElement, headers: string[], rows: ReportTableCell[][]): void {
		const wrapper = container.createDiv();
		wrapper.style.cssText = 'overflow-x:auto;';
		const table = wrapper.createEl('table');
		table.className = 'table-view-table';
		table.style.width = '100%';

		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		for (const header of headers) {
			headerRow.createEl('th', { text: header });
		}

		const tbody = table.createEl('tbody');
		for (const row of rows) {
			const tr = tbody.createEl('tr');
			for (const value of row) {
				const td = tr.createEl('td');
				if (value instanceof HTMLElement) {
					td.appendChild(value);
				} else {
					td.setText(value);
				}
			}
		}
	}

	private createFileLinkCell(file: TFile | null, fallbackLabel: string): HTMLElement {
		if (!file) {
			const span = document.createElement('span');
			span.textContent = fallbackLabel;
			return span;
		}

		return this.createInternalLink(file, file.basename);
	}

	private createReferenceCell(reference: string | undefined): HTMLElement {
		const linkPath = this.extractLinkPath(reference);
		if (!linkPath) {
			const span = document.createElement('span');
			span.textContent = '';
			return span;
		}

		const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
		const label = target?.basename || linkPath.split('/').pop() || linkPath;
		if (!target) {
			const span = document.createElement('span');
			span.textContent = label;
			return span;
		}

		return this.createInternalLink(target, label);
	}

	private createInternalLink(file: TFile, label: string): HTMLElement {
		const link = document.createElement('a');
		link.textContent = label;
		link.href = file.path;
		link.className = 'internal-link';
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.getLeaf(false).openFile(file);
		});
		return link;
	}

	private formatMoney(value: number, currency: string): string {
		return `${new Intl.NumberFormat('ru-RU', {
			minimumFractionDigits: 0,
			maximumFractionDigits: 2,
		}).format(Number(value ?? 0))} ${currency}`;
	}

	private formatShortMoney(value: number): string {
		const amount = Number(value ?? 0);
		const abs = Math.abs(amount);
		if (abs >= 1_000_000) {
			return `${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
		}
		if (abs >= 1_000) {
			return `${(amount / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
		}
		return new Intl.NumberFormat('ru-RU', {
			maximumFractionDigits: 0,
		}).format(amount);
	}

	private buildPieChartSvg(categories: CategorySummary[], centerLabel: string): string {
		const total = categories.reduce((sum, category) => sum + category.total, 0);
		const size = 180;
		const center = size / 2;
		const radius = 72;
		const circumference = 2 * Math.PI * radius;
		let offset = 0;

		const segments = categories.map((category, index) => {
			const share = total > 0 ? category.total / total : 0;
			const length = share * circumference;
			const segment = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length]}" stroke-width="24" stroke-linecap="butt" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${center} ${center})"></circle>`;
			offset += length;
			return segment;
		}).join('');

		return `<svg viewBox="0 0 ${size} ${size}" width="180" height="180" aria-label="${this.escapeHtml(centerLabel)} chart"><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--background-secondary)" stroke-width="24"></circle>${segments}<circle cx="${center}" cy="${center}" r="49" fill="var(--background-primary)"></circle><text x="${center}" y="${center - 6}" text-anchor="middle" font-size="12" fill="var(--text-muted)">${this.escapeHtml(centerLabel)}</text><text x="${center}" y="${center + 18}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text-normal)">${this.escapeHtml(this.formatShortMoney(total))}</text></svg>`;
	}

	private buildPieChartLegend(categories: CategorySummary[], currency: string): string {
		return categories.map((category, index) => `
			<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:12px; background:var(--background-secondary); margin-bottom:8px;">
				<div style="display:flex; align-items:center; gap:8px;">
					<span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:${REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length]};"></span>
					<span>${this.escapeHtml(category.category)}</span>
				</div>
				<div style="text-align:right; color:var(--text-muted);">
					<div>${this.escapeHtml(this.formatMoney(category.total, currency))}</div>
					<span style="font-size:11px;">${this.escapeHtml(`${category.percentage.toFixed(1)}%`)}</span>
				</div>
			</div>
		`).join('');
	}

	private buildBarTrendChartSvg(labels: string[], expenses: number[], incomes: number[]): string {
		const maxValue = Math.max(1, ...expenses, ...incomes);
		const chartHeight = 260;
		const chartWidth = 820;
		const paddingLeft = 52;
		const paddingBottom = 34;
		const chartTop = 18;
		const innerHeight = chartHeight - chartTop - paddingBottom;
		const groupWidth = (chartWidth - paddingLeft - 16) / labels.length;
		const barWidth = Math.max(10, Math.floor(groupWidth / 3));
		const scale = (value: number): number => (value / maxValue) * innerHeight;
		const gridLines = Array.from({ length: 5 }, (_, step) => {
			const y = chartTop + innerHeight - (innerHeight / 4) * step;
			const value = (maxValue / 4) * step;
			return `<line x1="${paddingLeft}" y1="${y}" x2="${chartWidth - 12}" y2="${y}" stroke="var(--background-modifier-border)" stroke-width="1"></line><text x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${this.escapeHtml(this.formatShortMoney(value))}</text>`;
		}).join('');
		const bars = labels.map((label, index) => {
			const baseX = paddingLeft + index * groupWidth + groupWidth / 2;
			const expenseHeight = scale(expenses[index] ?? 0);
			const incomeHeight = scale(incomes[index] ?? 0);
			const baseY = chartTop + innerHeight;
			return `<rect x="${baseX - barWidth - 4}" y="${baseY - expenseHeight}" width="${barWidth}" height="${expenseHeight}" rx="8" ry="8" fill="#d9485f"></rect><rect x="${baseX + 4}" y="${baseY - incomeHeight}" width="${barWidth}" height="${incomeHeight}" rx="8" ry="8" fill="#22a06b"></rect><text x="${baseX}" y="${chartHeight - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${this.escapeHtml(label)}</text>`;
		}).join('');
		return `<svg viewBox="0 0 ${chartWidth} ${chartHeight}" width="100%" height="${chartHeight}">${gridLines}${bars}</svg>`;
	}

	private buildBarTrendLegend(): string {
		return '<div style="display:flex; gap:16px; margin-top:8px; color:var(--text-muted);"><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#d9485f; margin-right:6px;"></span>Expenses</span><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#22a06b; margin-right:6px;"></span>Income</span></div>';
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private async buildDashboardMonthlyState(
		options: DashboardRenderOptions,
		monthDate: Date,
	): Promise<DashboardMonthlyState> {
		const transactions = await this.getAllTransactions();
		const scopedTransactions = transactions.filter((transaction) =>
			this.matchesDashboardTransactionsRoot(transaction, options.transactionsRoot),
		);
		const descriptor = {
			kind: 'month' as const,
			key: this.getMonthPeriodKey(monthDate),
			label: monthDate.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
			startDate: this.getMonthStart(monthDate),
			endDate: this.getMonthEnd(monthDate),
		};
		const monthReport = this.buildPeriodReportFromTransactions(scopedTransactions, descriptor, null);
		const reportFrontmatter = this.getDashboardReportFrontmatter(options.reportsRoot, descriptor.key);

		return {
			monthDate: descriptor.startDate,
			report: reportFrontmatter,
			expenseCategories: monthReport.expenseByCategory.slice(0, 8),
			totalExpenses: monthReport.totalExpenses,
			totalIncome: monthReport.totalIncome,
			openingBalance: monthReport.openingBalance,
			closingBalance: monthReport.closingBalance,
		};
	}

	private async buildDashboardYearlyState(
		options: DashboardRenderOptions,
		year: number,
	): Promise<DashboardYearlyState> {
		const transactions = await this.getAllTransactions();
		const scopedTransactions = transactions.filter((transaction) =>
			this.matchesDashboardTransactionsRoot(transaction, options.transactionsRoot),
		);
		const expenses = Array.from({ length: 12 }, () => 0);
		const incomes = Array.from({ length: 12 }, () => 0);

		for (const transaction of scopedTransactions) {
			const date = new Date(transaction.dateTime);
			if (date.getFullYear() !== year) {
				continue;
			}

			const monthIndex = date.getMonth();
			if (transaction.type === 'income') {
				incomes[monthIndex] += transaction.amount;
			} else {
				expenses[monthIndex] += transaction.amount;
			}
		}

		const monthlyReports = this.getDashboardReportFrontmatters(options.reportsRoot).filter((frontmatter) => {
			const kind = typeof frontmatter.periodKind === 'string' ? frontmatter.periodKind : '';
			const periodStart = typeof frontmatter.periodStart === 'string' ? frontmatter.periodStart : '';
			return kind === 'month' && periodStart.startsWith(`${year}-`);
		});

		return {
			year,
			expenses,
			incomes,
			warningMonths: monthlyReports.filter((report) => String(report.budget_alert_level ?? '') === 'warning').length,
			forecastMonths: monthlyReports.filter((report) => String(report.budget_alert_level ?? '') === 'forecast').length,
			criticalMonths: monthlyReports.filter((report) => String(report.budget_alert_level ?? '') === 'critical').length,
		};
	}

	private renderDashboardMonthSection(
		container: HTMLElement,
		state: DashboardMonthlyState,
		mode: DashboardContributionMode,
		viewState: { monthDate: Date; year: number },
		render: () => Promise<void>,
	): void {
		const section = container.createDiv();
		section.style.cssText = 'padding:18px; border:1px solid var(--background-modifier-border); border-radius:24px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 90%, white 10%), var(--background-primary)); margin-bottom:18px;';

		const header = section.createDiv();
		header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px;';
		const titleWrap = header.createDiv();
		titleWrap.createEl('h3', { text: 'Finance by month', attr: { style: 'margin:0 0 4px 0;' } });
		titleWrap.createEl('div', {
			text: state.monthDate.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
			attr: { style: 'color:var(--text-muted);' },
		});

		if (mode === 'interactive') {
			const controls = header.createDiv();
			controls.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
			this.appendActionButton(controls, 'Prev', async () => {
				viewState.monthDate = this.addMonths(viewState.monthDate, -1);
				await render();
			});
			this.appendActionButton(controls, 'Current', async () => {
				viewState.monthDate = this.getMonthStart(new Date());
				await render();
			}, this.isSameMonth(state.monthDate, new Date()));
			this.appendActionButton(controls, 'Next', async () => {
				viewState.monthDate = this.addMonths(viewState.monthDate, 1);
				await render();
			});
		}

		const cardsGrid = section.createDiv();
		cardsGrid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:14px;';
		const report = state.report;
		if (report) {
			this.appendMetricCard(cardsGrid, 'Expenses', this.formatMoney(Number(report.totalExpenses ?? 0), this.settings.defaultCurrency));
			this.appendMetricCard(cardsGrid, 'Income', this.formatMoney(Number(report.totalIncome ?? 0), this.settings.defaultCurrency));
			this.appendMetricCard(cardsGrid, 'Opening', this.formatMoney(Number(report.openingBalance ?? 0), this.settings.defaultCurrency));
			this.appendMetricCard(cardsGrid, 'Closing', this.formatMoney(Number(report.closingBalance ?? 0), this.settings.defaultCurrency));
			this.appendMetricCard(
				cardsGrid,
				'Budget',
				report.budget !== null && report.budget !== undefined && report.budget !== ''
					? this.formatMoney(Number(report.budget), this.settings.defaultCurrency)
					: 'Not set',
			);
			this.appendMetricCard(cardsGrid, 'Status', this.getBudgetLevelLabel(String(report.budget_alert_level ?? 'none')));
		} else {
			section.createEl('div', {
				text: 'No monthly report note for this period yet.',
				attr: { style: 'color:var(--text-muted); margin-bottom:12px;' },
			});
		}

		if (report) {
			const alertBlock = this.buildDashboardAlertElement(report, this.settings.defaultCurrency);
			if (alertBlock) {
				section.appendChild(alertBlock);
			}
		}

		if (state.expenseCategories.length === 0) {
			section.createEl('div', {
				text: 'No expenses in this period.',
				attr: { style: 'color:var(--text-muted); margin-top:14px;' },
			});
			return;
		}

		const chartRow = section.createDiv();
		chartRow.style.cssText = 'display:grid; grid-template-columns:minmax(200px, 240px) 1fr; gap:18px; align-items:center; margin-top:14px;';
		const pieContainer = chartRow.createDiv();
		pieContainer.style.cssText = 'display:flex; justify-content:center;';
		pieContainer.innerHTML = this.buildPieChartSvg(state.expenseCategories, 'Expenses');

		const legendContainer = chartRow.createDiv();
		legendContainer.innerHTML = this.buildPieChartLegend(state.expenseCategories, this.settings.defaultCurrency);
	}

	private renderDashboardYearSection(
		container: HTMLElement,
		state: DashboardYearlyState,
		mode: DashboardContributionMode,
		viewState: { monthDate: Date; year: number },
		render: () => Promise<void>,
	): void {
		const section = container.createDiv();
		section.style.cssText = 'padding:18px; border:1px solid var(--background-modifier-border); border-radius:24px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 90%, white 8%), var(--background-primary)); margin-bottom:18px;';

		const header = section.createDiv();
		header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px;';
		const titleWrap = header.createDiv();
		titleWrap.createEl('h3', { text: 'Finance by year', attr: { style: 'margin:0 0 4px 0;' } });
		titleWrap.createEl('div', {
			text: String(state.year),
			attr: { style: 'color:var(--text-muted);' },
		});

		if (mode === 'interactive') {
			const controls = header.createDiv();
			controls.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
			this.appendActionButton(controls, 'Prev year', async () => {
				viewState.year -= 1;
				await render();
			});
			this.appendActionButton(controls, 'Current year', async () => {
				viewState.year = new Date().getFullYear();
				await render();
			}, state.year === new Date().getFullYear());
			this.appendActionButton(controls, 'Next year', async () => {
				viewState.year += 1;
				await render();
			});
		}

		const totalsGrid = section.createDiv();
		totalsGrid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:14px;';
		this.appendMetricCard(totalsGrid, 'Expenses', this.formatMoney(state.expenses.reduce((sum, value) => sum + value, 0), this.settings.defaultCurrency));
		this.appendMetricCard(totalsGrid, 'Income', this.formatMoney(state.incomes.reduce((sum, value) => sum + value, 0), this.settings.defaultCurrency));
		this.appendMetricCard(totalsGrid, 'Warning months', String(state.warningMonths));
		this.appendMetricCard(totalsGrid, 'Critical months', String(state.criticalMonths));

		if (state.warningMonths || state.forecastMonths || state.criticalMonths) {
			const strip = section.createDiv();
			strip.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;';
			this.appendAlertPill(strip, 'Warning', state.warningMonths, 'warning');
			this.appendAlertPill(strip, 'Forecast', state.forecastMonths, 'forecast');
			this.appendAlertPill(strip, 'Critical', state.criticalMonths, 'critical');
		}

		const chartContainer = section.createDiv();
		chartContainer.style.cssText = 'margin-top:8px; overflow-x:auto;';
		const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		chartContainer.innerHTML = `${this.buildBarTrendChartSvg(labels, state.expenses, state.incomes)}${this.buildBarTrendLegend()}`;
	}

	private appendActionButton(
		container: HTMLElement,
		label: string,
		onClick: () => Promise<void>,
		isActive = false,
	): void {
		const button = container.createEl('button', { text: label });
		button.style.cssText = `border:1px solid ${isActive ? 'var(--interactive-accent)' : 'var(--background-modifier-border)'}; background:${isActive ? 'var(--interactive-accent-hover)' : 'var(--background-secondary)'}; color:var(--text-normal); border-radius:999px; padding:6px 12px; font-size:12px; cursor:pointer;`;
		button.addEventListener('click', () => {
			void onClick();
		});
	}

	private appendAlertPill(
		container: HTMLElement,
		label: string,
		count: number,
		level: 'warning' | 'forecast' | 'critical',
	): void {
		const meta = this.getBudgetLevelMeta(level);
		const pill = container.createSpan({
			text: `${label}: ${count}`,
		});
		pill.style.cssText = `padding:6px 10px; border-radius:999px; background:${meta.bg}; color:${meta.tone};`;
	}

	private getDashboardReportFrontmatter(reportsRoot: string, periodKey: string): Record<string, unknown> | null {
		return this.getDashboardReportFrontmatters(reportsRoot).find((frontmatter) =>
			String(frontmatter.periodKind ?? '') === 'month' && String(frontmatter.periodKey ?? '') === periodKey,
		) ?? null;
	}

	private getDashboardReportFrontmatters(reportsRoot: string): Record<string, unknown>[] {
		const normalizedRoot = normalizePath(reportsRoot);
		return this.getReportFiles()
			.filter((file) => normalizePath(file.parent?.path ?? '') === normalizedRoot)
			.map((file) => this.app.metadataCache.getFileCache(file)?.frontmatter ?? null)
			.filter((frontmatter): frontmatter is Record<string, unknown> => Boolean(frontmatter))
			.filter((frontmatter) => String(frontmatter.type ?? '') === 'finance-report');
	}

	private buildDashboardAlertElement(
		report: Record<string, unknown>,
		currency: string,
	): HTMLElement | null {
		if (
			report.budget === null
			|| report.budget === undefined
			|| report.budget === ''
			|| !report.budget_alert_level
			|| String(report.budget_alert_level) === 'none'
			|| String(report.budget_alert_level) === 'ok'
		) {
			return null;
		}

		const level = String(report.budget_alert_level);
		const meta = this.getBudgetLevelMeta(level);
		const usage = report.budget_usage_percentage == null ? '-' : `${Number(report.budget_usage_percentage).toFixed(1)}%`;
		const wrapper = document.createElement('div');
		wrapper.style.cssText = `padding:14px 16px; border-radius:18px; background:${meta.bg}; border:1px solid ${meta.tone}; color:${meta.tone}; margin-bottom:12px;`;
		wrapper.createEl('div', {
			text: `Budget alert: ${meta.label}`,
			attr: { style: 'font-weight:700; margin-bottom:4px;' },
		});
		wrapper.createEl('div', {
			text: `Used: ${usage} of ${this.formatMoney(Number(report.budget ?? 0), currency)}`,
		});

		if (level === 'critical') {
			wrapper.createEl('div', {
				text: `Over budget: ${this.formatMoney(Math.abs(Number(report.budget_remaining ?? 0)), currency)}`,
			});
			return wrapper;
		}

		if (level === 'forecast') {
			wrapper.createEl('div', {
				text: `Projected month end: ${this.formatMoney(Number(report.budget_projected_spent ?? 0), currency)}`,
			});
			wrapper.createEl('div', {
				text: `Expected overrun: ${this.formatMoney(Math.max(0, Number(report.budget_projected_delta ?? 0)), currency)}`,
			});
			return wrapper;
		}

		wrapper.createEl('div', {
			text: `Remaining: ${this.formatMoney(Number(report.budget_remaining ?? 0), currency)}`,
		});
		return wrapper;
	}

	private getBudgetLevelLabel(level: string): string {
		return this.getBudgetLevelMeta(level).label;
	}

	private getBudgetLevelMeta(level: string): { label: string; tone: string; bg: string } {
		if (level === 'critical') {
			return { label: 'Critical', tone: '#be123c', bg: 'rgba(190, 18, 60, 0.10)' };
		}
		if (level === 'forecast') {
			return { label: 'Forecast', tone: '#b45309', bg: 'rgba(180, 83, 9, 0.10)' };
		}
		if (level === 'warning') {
			return { label: 'Warning', tone: '#c2410c', bg: 'rgba(194, 65, 12, 0.10)' };
		}
		if (level === 'ok') {
			return { label: 'OK', tone: '#15803d', bg: 'rgba(21, 128, 61, 0.10)' };
		}
		return { label: 'No alerts', tone: '#6b7280', bg: 'rgba(107, 114, 128, 0.08)' };
	}

	private matchesDashboardTransactionsRoot(transaction: TransactionData, rootPath: string): boolean {
		const filePath = normalizePath(transaction.file?.path ?? '');
		const normalizedRoot = normalizePath(rootPath);
		return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`);
	}

	private getMonthStart(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth(), 1);
	}

	private getMonthEnd(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
	}

	private addMonths(date: Date, delta: number): Date {
		return new Date(date.getFullYear(), date.getMonth() + delta, 1);
	}

	private isSameMonth(left: Date, right: Date): boolean {
		return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
	}

	private getMonthPeriodKey(date: Date): string {
		return `${date.getFullYear()}-${date.toLocaleString('en-US', { month: 'short' })}`;
	}

	private async createTransactionViaParaCore(data: TransactionData): Promise<TFile> {
		if (!this.paraCoreApi) {
			throw new Error('PARA Core API is not available');
		}

		const type = data.type === 'expense' ? 'finance-expense' : 'finance-income';
		const filename = generateFilename(data).replace(/\.md$/i, '');
		const tags = Array.from(new Set(['finance', data.type, ...data.tags]));

		return this.paraCoreApi.createNote({
			type,
			title: data.description || filename,
			folderOverride: this.getTransactionFolderPath(data.dateTime),
			fileNameOverride: filename,
			openAfterCreate: false,
			frontmatterOverrides: {
				dateTime: data.dateTime,
				amount: data.amount,
				currency: data.currency,
				description: data.description,
				area: data.area ?? null,
				project: data.project ?? null,
				category: data.category || data.tags[0] || 'uncategorized',
				source: data.source,
				artifact: data.artifact ?? null,
				tags,
				fn: data.fn,
				fd: data.fd,
				fp: data.fp,
				details: data.details ?? [],
			},
		});
	}

	async upsertReportFile(
		report: PeriodReport,
		options?: {
			existingFile?: TFile | null;
		},
	): Promise<TFile> {
		const descriptor: ReportPeriodDescriptor = {
			kind: report.periodKind,
			key: report.periodKey,
			label: report.periodLabel,
			startDate: report.startDate,
			endDate: report.endDate,
		};
		const expectedReportPath = normalizePath(
			`${this.getReportsFolderPath()}/${this.getReportFileName(report)}`,
		);
		const existingByPath = this.app.vault.getAbstractFileByPath(expectedReportPath);
		const existing =
			options?.existingFile ??
			(existingByPath instanceof TFile ? existingByPath : null) ??
			await this.findManagedReportFile(descriptor);
		const existingBudget = existing ? await this.readReportBudget(existing) : report.budget?.limit ?? null;
		const existingAlertState = existing ? await this.readReportBudgetAlertState(existing) : this.createEmptyBudgetAlertState();
		const reportForSave = this.applyPersistedBudgetState(report, existingBudget, existingAlertState);

		if (existing) {
			return this.syncExistingReportFile(existing, reportForSave);
		}

		const reportsFolder = await this.ensureFolderPath(this.getReportsFolderPath());
		const filepath = normalizePath(`${reportsFolder}/${this.getReportFileName(reportForSave)}`);
		const content = this.generateReportMarkdown(reportForSave);
		const indexedDuringBootstrap = await this.resolveIndexedMarkdownFile(filepath);
		if (indexedDuringBootstrap) {
			return this.syncExistingReportFile(indexedDuringBootstrap, reportForSave);
		}

		try {
			return await this.app.vault.create(filepath, content);
		} catch (error) {
			if (!this.isAlreadyExistsError(error)) {
				throw error;
			}

			const indexedAfterConflict =
				await this.waitForIndexedMarkdownFile(filepath) ??
				await this.findManagedReportFile(descriptor);
			if (indexedAfterConflict) {
				return this.syncExistingReportFile(indexedAfterConflict, reportForSave);
			}

			throw error;
		}
	}

	hydrateReportWithBudgetState(
		report: PeriodReport,
		budgetLimit: number | null,
		alertState: ReportBudgetAlertState,
	): PeriodReport {
		return this.applyPersistedBudgetState(report, budgetLimit, alertState);
	}

	buildManagedReportId(
		descriptor: Pick<ReportPeriodDescriptor, 'kind' | 'key' | 'startDate' | 'endDate'>,
	): string {
		const key = descriptor.kind === 'custom'
			? `${formatDateKey(descriptor.startDate)}-to-${formatDateKey(descriptor.endDate)}`
			: descriptor.key;
		return `${descriptor.kind}-${key}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
	}

	async findManagedReportFile(descriptor: ReportPeriodDescriptor): Promise<TFile | null> {
		return this.findReportFile(descriptor.kind, descriptor.startDate, descriptor.endDate, {
			reportId: this.buildManagedReportId(descriptor),
			reportOwner: MANAGED_REPORT_OWNER,
			includeLegacyManaged: true,
		});
	}

	async findReportFile(
		periodKind: ReportPeriodKind,
		startDate: Date,
		endDate: Date,
		options?: {
			reportId?: string;
			reportOwner?: string;
			includeLegacyManaged?: boolean;
		},
	): Promise<TFile | null> {
		const reportFiles = this.getReportFiles();
		const targetStart = formatDateKey(startDate);
		const targetEnd = formatDateKey(endDate);
		let legacyCandidate: TFile | null = null;

		for (const file of reportFiles) {
			const content = await this.app.vault.cachedRead(file);
			const frontmatter = parseYamlFrontmatter(content);
			if (!frontmatter) {
				continue;
			}

			const type = typeof frontmatter.type === 'string' ? frontmatter.type : '';
			if (type !== 'finance-report' && type !== 'financial-report') {
				continue;
			}

			const fileStart = typeof frontmatter.periodStart === 'string'
				? frontmatter.periodStart
				: typeof frontmatter.period === 'string'
					? String(frontmatter.period).split(' to ')[0]?.trim()
					: null;
			const fileEnd = typeof frontmatter.periodEnd === 'string'
				? frontmatter.periodEnd
				: typeof frontmatter.period === 'string'
					? String(frontmatter.period).split(' to ')[1]?.trim()
					: null;
			const fileOwner = typeof frontmatter.reportOwner === 'string' ? frontmatter.reportOwner : null;
			const fileReportId = typeof frontmatter.reportId === 'string' ? frontmatter.reportId : null;
			const fileKind = typeof frontmatter.periodKind === 'string'
				? frontmatter.periodKind
				: (fileStart && fileEnd ? 'custom' : null);
			const ownerMatches = this.matchesReportOwner(
				fileOwner,
				options?.reportOwner ?? null,
				options?.includeLegacyManaged ?? true,
			);
			if (!ownerMatches) {
				continue;
			}

			if (options?.reportId && fileReportId === options.reportId) {
				return file;
			}

			if (fileStart === targetStart && fileEnd === targetEnd && fileKind === periodKind) {
				if (!options?.reportId || !fileReportId) {
					return file;
				}
				legacyCandidate = legacyCandidate ?? file;
			}
			if (fileStart === targetStart && fileEnd === targetEnd && periodKind === 'custom') {
				if (!options?.reportId || !fileReportId) {
					return file;
				}
				legacyCandidate = legacyCandidate ?? file;
			}
		}

		return legacyCandidate;
	}

	async getExistingBudgetForDescriptor(descriptor: ReportPeriodDescriptor): Promise<number | null> {
		const reportFile = await this.findManagedReportFile(descriptor);
		if (!reportFile) {
			return null;
		}
		return this.readReportBudget(reportFile);
	}

	private async syncExistingReportFile(existing: TFile, report: PeriodReport): Promise<TFile> {
		const desiredPath = normalizePath(`${existing.parent?.path ?? ''}/${this.getReportFileName(report)}`.replace(/^\/+/, ''));
		if (existing.path !== desiredPath && !this.app.vault.getAbstractFileByPath(desiredPath)) {
			await this.app.fileManager.renameFile(existing, desiredPath);
		}

		const currentContent = await this.app.vault.cachedRead(existing);
		const existingGeneratedAt = this.readGeneratedAt(currentContent) ?? new Date().toISOString();
		const stableContent = this.generateReportMarkdown(report, existingGeneratedAt);
		if (currentContent !== stableContent) {
			const updatedContent = this.generateReportMarkdown(report, new Date().toISOString());
			await this.app.vault.modify(existing, updatedContent);
		}

		return existing;
	}

	private async resolveIndexedMarkdownFile(path: string, attempts = 1, delayMs = 0): Promise<TFile | null> {
		const normalizedPath = normalizePath(path);
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const directHit = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (directHit instanceof TFile) {
				return directHit;
			}

			const listedHit = this.app.vault
				.getMarkdownFiles()
				.find((file) => normalizePath(file.path) === normalizedPath);
			if (listedHit) {
				return listedHit;
			}

			if (attempt < attempts - 1 && delayMs > 0) {
				await this.delay(delayMs);
			}
		}

		return null;
	}

	private waitForIndexedMarkdownFile(path: string): Promise<TFile | null> {
		return this.resolveIndexedMarkdownFile(path, 8, 50);
	}

	private async delay(ms: number): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	}

	async getReportBudgetAlertState(file: TFile): Promise<ReportBudgetAlertState> {
		return this.readReportBudgetAlertState(file);
	}

	createBudgetAlertStatePatch(
		currentState: ReportBudgetAlertState,
		alertLevel: ReportBudgetAlertLevel,
		timestamp = new Date().toISOString(),
	): ReportBudgetAlertState {
		if (alertLevel === 'critical') {
			return {
				sentWarning: true,
				sentForecast: true,
				sentCritical: true,
				lastAlertAt: timestamp,
			};
		}

		if (alertLevel === 'forecast') {
			return {
				...currentState,
				sentForecast: true,
				lastAlertAt: timestamp,
			};
		}

		if (alertLevel === 'warning') {
			return {
				...currentState,
				sentWarning: true,
				lastAlertAt: timestamp,
			};
		}

		return currentState;
	}

	async updateReportBudgetAlertState(file: TFile, state: ReportBudgetAlertState): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter.budget_alert_state_warning_sent = state.sentWarning;
			frontmatter.budget_alert_state_forecast_sent = state.sentForecast;
			frontmatter.budget_alert_state_critical_sent = state.sentCritical;
			if (state.lastAlertAt) {
				frontmatter.budget_alert_state_last_alert_at = state.lastAlertAt;
			} else {
				delete frontmatter.budget_alert_state_last_alert_at;
			}
		});
	}

	isTransactionFile(file: TFile): boolean {
		return this.isTransactionFilePath(file.path);
	}

	isReportFile(file: TFile): boolean {
		return this.getReportFolderPaths().some((folderPath) => file.parent?.path === folderPath);
	}

	listTransactionFiles(): TFile[] {
		return this.getTransactionFiles();
	}

	listReportFiles(): TFile[] {
		return this.getReportFiles();
	}

	async relocateTransactionFile(file: TFile, dateTime: string | undefined): Promise<TFile> {
		if (!this.isTransactionFile(file)) {
			return file;
		}

		const targetFolder = await this.ensureFolderPath(this.getTransactionFolderPath(dateTime));
		const desiredPath = normalizePath(`${targetFolder}/${file.name}`);
		if (normalizePath(file.path) === desiredPath) {
			return file;
		}

		const availablePath = this.getAvailablePath(targetFolder, file.name);
		if (normalizePath(file.path) === availablePath) {
			return file;
		}

		await this.app.fileManager.renameFile(file, availablePath);
		return file;
	}

	private calculateOpeningBalance(transactions: TransactionData[], startDate: Date): number {
		let balance = 0;
		for (const transaction of transactions) {
			const transactionTime = new Date(transaction.dateTime).getTime();
			if (transactionTime >= startDate.getTime()) {
				break;
			}
			balance += transaction.type === 'income' ? transaction.amount : -transaction.amount;
		}
		return balance;
	}

	private bumpCategory(
		categoryMap: Map<string, { total: number; count: number }>,
		category: string,
		amount: number,
	): void {
		const existing = categoryMap.get(category) || { total: 0, count: 0 };
		existing.total += amount;
		existing.count += 1;
		categoryMap.set(category, existing);
	}

	private finalizeCategorySummary(
		categoryMap: Map<string, { total: number; count: number }>,
		grandTotal: number,
	): CategorySummary[] {
		return Array.from(categoryMap.entries())
			.map(([category, data]) => ({
				category,
				total: data.total,
				count: data.count,
				percentage: grandTotal > 0 ? (data.total / grandTotal) * 100 : 0,
			}))
			.sort((left, right) => right.total - left.total);
	}

	private buildBudgetSummary(
		limit: number | null,
		spent: number,
		descriptor: ReportPeriodDescriptor,
	): ReportBudgetSummary | null {
		if (limit === null || limit === undefined || !Number.isFinite(limit)) {
			return null;
		}

		const warningThresholdPercentage = this.normalizeWarningThreshold(this.settings.budgetAlertWarningThresholdPercent);
		const usagePercentage = limit === 0 ? null : (spent / limit) * 100;
		const alertsEnabled = this.settings.enableBudgetAlerts;
		const forecastEnabled = this.settings.enableBudgetForecastAlerts;
		const projectedSpent = this.calculateProjectedSpent(descriptor, spent);
		const projectedDelta = projectedSpent === null ? null : projectedSpent - limit;
		const alertLevel = this.resolveBudgetAlertLevel({
			descriptor,
			limit,
			spent,
			usagePercentage,
			projectedSpent,
			projectedDelta,
			alertsEnabled,
			forecastEnabled,
			warningThresholdPercentage,
		});

		return {
			limit,
			spent,
			remaining: limit - spent,
			usagePercentage,
			warningThresholdPercentage,
			projectedSpent,
			projectedDelta,
			alertLevel,
			alertsEnabled,
			forecastEnabled,
			alertState: this.createEmptyBudgetAlertState(),
		};
	}

	private buildReportDataviewTemplate(): string[] {
		return [
			'## Live Report',
			'',
			'### Summary',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("summary", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Expense Categories',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("expense-categories", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Income Categories',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("income-categories", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Expense Chart',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("expense-chart", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Income Chart',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("income-chart", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Monthly Trend',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("trend", container, dv.current().file.path);',
			'})();',
			'```',
			'',
			'### Transactions',
			'```dataviewjs',
			'const container = dv.el("div", "");',
			'const plugin = app.plugins.plugins["expense-manager"];',
			'(async () => {',
			'  if (!plugin?.renderReportSection) {',
			'    container.setText("Expense Manager plugin API is unavailable.");',
			'    return;',
			'  }',
			'  await plugin.renderReportSection("transactions", container, dv.current().file.path);',
			'})();',
			'```',
		];
	}

	private renderCategorySection(title: string, categories: CategorySummary[]): string {
		let content = `## ${title}\n\n`;
		if (categories.length === 0) {
			return `${content}_No records in this period._\n\n`;
		}

		content += `| Category | Amount | % | Count |\n`;
		content += `|----------|--------|---|-------|\n`;
		for (const category of categories) {
			content += `| ${category.category} | ${category.total.toFixed(2)} RUB | ${category.percentage.toFixed(1)}% | ${category.count} |\n`;
		}
		content += '\n';
		return content;
	}

	private renderMermaidPieSection(title: string, categories: CategorySummary[]): string {
		if (categories.length === 0) {
			return '';
		}

		const topCategories = categories.slice(0, 8);
		const lines = [
			`## ${title}`,
			'',
			'```mermaid',
			'pie showData',
		];
		for (const category of topCategories) {
			lines.push(`    "${category.category}" : ${category.total.toFixed(2)}`);
		}
		lines.push('```', '');
		return lines.join('\n');
	}

	private renderMonthlyTrendSection(report: PeriodReport): string {
		if (report.periodKind !== 'year') {
			return '';
		}

		const buckets = new Map<string, { income: number; expense: number }>();
		for (const transaction of report.transactions) {
			const date = new Date(transaction.dateTime);
			const label = date.toLocaleString('en-US', { month: 'short' });
			const current = buckets.get(label) || { income: 0, expense: 0 };
			if (transaction.type === 'income') {
				current.income += transaction.amount;
			} else {
				current.expense += transaction.amount;
			}
			buckets.set(label, current);
		}

		if (buckets.size === 0) {
			return '';
		}

		const labels = Array.from(buckets.keys());
		const expenses = labels.map((label) => (buckets.get(label)?.expense ?? 0).toFixed(2));
		const incomes = labels.map((label) => (buckets.get(label)?.income ?? 0).toFixed(2));
		const maxValue = Math.max(
			...labels.map((label) => Math.max(buckets.get(label)?.income ?? 0, buckets.get(label)?.expense ?? 0)),
		);

		return [
			'## 📈 Monthly trend',
			'',
			'```mermaid',
			'xychart-beta',
			'    title "Monthly income vs expenses"',
			`    x-axis [${labels.map((label) => `"${label}"`).join(', ')}]`,
			`    y-axis "Amount" 0 --> ${Math.ceil(maxValue || 1)}`,
			`    bar "Expenses" [${expenses.join(', ')}]`,
			`    bar "Income" [${incomes.join(', ')}]`,
			'```',
			'',
		].join('\n');
	}

	private async readReportBudget(file: TFile): Promise<number | null> {
		const content = await this.app.vault.cachedRead(file);
		const frontmatter = parseYamlFrontmatter(content);
		if (!frontmatter) {
			return null;
		}

		const rawBudget = frontmatter.budget;
		if (rawBudget === null || rawBudget === undefined || rawBudget === '') {
			return null;
		}

		const budget = Number(rawBudget);
		return Number.isFinite(budget) ? budget : null;
	}

	private async readReportBudgetAlertState(file: TFile): Promise<ReportBudgetAlertState> {
		const content = await this.app.vault.cachedRead(file);
		const frontmatter = parseYamlFrontmatter(content);
		if (!frontmatter) {
			return this.createEmptyBudgetAlertState();
		}

		return {
			sentWarning: frontmatter.budget_alert_state_warning_sent === true,
			sentForecast: frontmatter.budget_alert_state_forecast_sent === true,
			sentCritical: frontmatter.budget_alert_state_critical_sent === true,
			lastAlertAt: typeof frontmatter.budget_alert_state_last_alert_at === 'string'
				? frontmatter.budget_alert_state_last_alert_at
				: null,
		};
	}

	private readGeneratedAt(content: string): string | null {
		const frontmatter = parseYamlFrontmatter(content);
		if (!frontmatter) {
			return null;
		}

		return typeof frontmatter.generatedAt === 'string' ? frontmatter.generatedAt : null;
	}

	private applyPersistedBudgetState(
		report: PeriodReport,
		budgetLimit: number | null,
		alertState: ReportBudgetAlertState,
	): PeriodReport {
		const budget = this.buildBudgetSummary(
			budgetLimit ?? report.budget?.limit ?? null,
			report.totalExpenses,
			{
				kind: report.periodKind,
				key: report.periodKey,
				label: report.periodLabel,
				startDate: report.startDate,
				endDate: report.endDate,
			},
		);

		if (!budget) {
			return {
				...report,
				budget: null,
			};
		}

		return {
			...report,
			budget: {
				...budget,
				alertState,
			},
		};
	}

	private calculateProjectedSpent(descriptor: ReportPeriodDescriptor, spent: number): number | null {
		if (!this.settings.enableBudgetForecastAlerts || descriptor.kind !== 'month') {
			return null;
		}

		const now = new Date();
		if (now.getTime() < descriptor.startDate.getTime() || now.getTime() > descriptor.endDate.getTime()) {
			return null;
		}

		const currentDay = now.getDate();
		if (currentDay < Math.max(1, this.settings.budgetForecastStartDay)) {
			return null;
		}

		const totalDays = descriptor.endDate.getDate();
		const elapsedDays = Math.min(Math.max(currentDay, 1), totalDays);
		if (elapsedDays <= 0) {
			return null;
		}

		return (spent / elapsedDays) * totalDays;
	}

	private resolveBudgetAlertLevel(options: {
		descriptor: ReportPeriodDescriptor;
		limit: number;
		spent: number;
		usagePercentage: number | null;
		projectedSpent: number | null;
		projectedDelta: number | null;
		alertsEnabled: boolean;
		forecastEnabled: boolean;
		warningThresholdPercentage: number;
	}): ReportBudgetAlertLevel {
		if (!options.alertsEnabled) {
			return 'none';
		}
		if (options.spent > options.limit) {
			return 'critical';
		}
		if (
			options.forecastEnabled &&
			options.descriptor.kind === 'month' &&
			options.projectedSpent !== null &&
			options.projectedDelta !== null &&
			options.projectedDelta > 0
		) {
			return 'forecast';
		}
		if (
			options.usagePercentage !== null &&
			options.usagePercentage >= options.warningThresholdPercentage
		) {
			return 'warning';
		}
		return 'ok';
	}

	private createEmptyBudgetAlertState(): ReportBudgetAlertState {
		return {
			sentWarning: false,
			sentForecast: false,
			sentCritical: false,
			lastAlertAt: null,
		};
	}

	private normalizeWarningThreshold(rawValue: number): number {
		if (!Number.isFinite(rawValue)) {
			return 80;
		}
		return Math.min(100, Math.max(1, rawValue));
	}

	private getReportFileName(report: PeriodReport): string {
		if (report.periodKind === 'custom') {
			return `financial-report-${formatDateKey(report.startDate)}-to-${formatDateKey(report.endDate)}.md`;
		}
		if (report.periodKind === 'month') {
			return `financial-report-${report.periodKey}.md`;
		}
		if (report.periodKind === 'quarter') {
			return `financial-report-${report.periodKey}.md`;
		}
		if (report.periodKind === 'half-year') {
			return `financial-report-${report.periodKey}.md`;
		}
		return `financial-report-${report.periodKey}.md`;
	}

	private matchesReportOwner(
		fileOwner: string | null,
		requestedOwner: string | null,
		includeLegacyManaged: boolean,
	): boolean {
		if (!requestedOwner) {
			return true;
		}
		if (fileOwner === requestedOwner) {
			return true;
		}
		return includeLegacyManaged && requestedOwner === MANAGED_REPORT_OWNER && !fileOwner;
	}

	private getTransactionsRootPath(): string {
		return this.financeDomain
			? `${this.financeDomain.recordsPath}/Transactions`
			: this.settings.expenseFolder;
	}

	private getTransactionFolderPaths(): string[] {
		const folders = [this.settings.expenseFolder];
		if (this.financeDomain) {
			folders.push(`${this.financeDomain.recordsPath}/Transactions`);
		}
		return folders;
	}

	private getTransactionFolderPath(date?: string): string {
		const root = this.financeDomain
			? `${this.financeDomain.recordsPath}/Transactions`
			: this.settings.expenseFolder;
		const { year, month } = this.resolveStorageDateParts(date);
		return `${root}/${year}/${month}`;
	}

	private getReportFolderPaths(): string[] {
		return [this.getReportsFolderPath()];
	}

	private getArtifactsFolderPath(date?: string): string {
		const root = this.financeDomain
			? this.financeDomain.attachmentsPath ?? this.financeDomain.recordsPath
			: `${this.settings.expenseFolder}/Artifacts`;
		const { year, month } = this.resolveStorageDateParts(date);
		return `${root}/${year}/${month}`;
	}

	private resolveStorageDateParts(date?: string): { year: string; month: string } {
		const parsed = date ? new Date(date) : new Date();
		const resolved = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
		return {
			year: String(resolved.getFullYear()),
			month: String(resolved.getMonth() + 1).padStart(2, '0'),
		};
	}

	private buildArtifactFileName(date: string | undefined, fileName: string): string {
		const parsed = date ? new Date(date) : new Date();
		const resolved = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
		const year = String(resolved.getFullYear());
		const month = String(resolved.getMonth() + 1).padStart(2, '0');
		const day = String(resolved.getDate()).padStart(2, '0');
		const hours = String(resolved.getHours()).padStart(2, '0');
		const minutes = String(resolved.getMinutes()).padStart(2, '0');
		const seconds = String(resolved.getSeconds()).padStart(2, '0');
		return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}-${fileName}`;
	}

	private getReportsFolderPath(): string {
		if (this.financeDomain) {
			return `${this.financeDomain.recordsPath}/Reports`;
		}
		return `${this.settings.expenseFolder}/Reports`;
	}

	private getReportFiles(): TFile[] {
		const folderPaths = this.getReportFolderPaths();
		const filesByPath = new Map<string, TFile>();
		for (const folderPath of folderPaths) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) {
				continue;
			}

			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === 'md') {
					filesByPath.set(child.path, child);
				}
			}
		}
		return [...filesByPath.values()];
	}

	private async ensureFolderPath(folderPath: string): Promise<string> {
		const normalizedParts = folderPath.split('/').filter(Boolean);
		let currentPath = '';
		for (const part of normalizedParts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch (error) {
					if (!this.isAlreadyExistsError(error)) {
						throw error;
					}
				}
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Path exists but is not a folder: ${currentPath}`);
			}
		}
		return folderPath;
	}

	private isAlreadyExistsError(error: unknown): boolean {
		return error instanceof Error && error.message.includes('already exists');
	}

	private async getAvailableArtifactPath(folderPath: string, fileName: string): Promise<string> {
		return this.getAvailablePath(folderPath, fileName);
	}

	private getAvailablePath(folderPath: string, fileName: string): string {
		const lastDot = fileName.lastIndexOf('.');
		const baseName = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
		const extension = lastDot > 0 ? fileName.slice(lastDot) : '';
		let attempt = 0;

		while (true) {
			const candidateName = attempt === 0 ? `${baseName}${extension}` : `${baseName}-${attempt}${extension}`;
			const candidatePath = normalizePath(`${folderPath}/${candidateName}`);
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
				return candidatePath;
			}
			attempt += 1;
		}
	}

	private getTransactionFiles(): TFile[] {
		const folders = this.getTransactionFolderPaths();
		const filesByPath = new Map<string, TFile>();
		for (const folderPath of folders) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) {
				continue;
			}

			this.collectMarkdownFiles(folder, filesByPath);
		}

		return [...filesByPath.values()].filter((file) => this.isTransactionFile(file));
	}

	private collectMarkdownFiles(folder: TFolder, filesByPath: Map<string, TFile>): void {
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				filesByPath.set(child.path, child);
				continue;
			}

			if (child instanceof TFolder) {
				this.collectMarkdownFiles(child, filesByPath);
			}
		}
	}

	private isTransactionFilePath(filePath: string): boolean {
		const normalizedFilePath = normalizePath(filePath);
		for (const rootPath of this.getTransactionFolderPaths()) {
			const normalizedRootPath = normalizePath(rootPath);
			const prefix = `${normalizedRootPath}/`;
			if (!normalizedFilePath.startsWith(prefix)) {
				continue;
			}

			const relativePath = normalizedFilePath.slice(prefix.length);
			const segments = relativePath.split('/').filter(Boolean);
			if (segments.length === 1) {
				return true;
			}

			if (segments.length === 3 && this.isYearMonthPath(segments[0], segments[1])) {
				return true;
			}
		}

		return false;
	}

	private isYearMonthPath(year: string, month: string): boolean {
		return /^\d{4}$/.test(year) && /^(0[1-9]|1[0-2])$/.test(month);
	}

	private normalizeTransactionType(type: string): 'expense' | 'income' {
		if (type === 'finance-expense') {
			return 'expense';
		}
		if (type === 'finance-income') {
			return 'income';
		}
		return type === 'income' ? 'income' : 'expense';
	}

	private canUseParaCoreRecords(): boolean {
		return Boolean(this.paraCoreApi && this.financeDomain);
	}

	private async getContextSummary(
		target: 'project' | 'area',
		file: TFile,
	): Promise<FinanceContextSummary> {
		const transactions = await this.getAllTransactions();
		const matching = transactions.filter((transaction) =>
			this.matchesLinkedFile(target === 'project' ? transaction.project : transaction.area, file),
		);

		const totalExpenses = matching
			.filter((transaction) => transaction.type === 'expense')
			.reduce((sum, transaction) => sum + transaction.amount, 0);
		const totalIncome = matching
			.filter((transaction) => transaction.type === 'income')
			.reduce((sum, transaction) => sum + transaction.amount, 0);
		const linkedProjectCount = new Set(
			matching
				.map((transaction) => transaction.project)
				.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
		).size;

		return {
			totalExpenses,
			totalIncome,
			balance: totalIncome - totalExpenses,
			transactionCount: matching.length,
			linkedProjectCount,
			recentTransactions: matching
				.slice()
				.sort((left, right) => new Date(right.dateTime).getTime() - new Date(left.dateTime).getTime())
				.slice(0, 5),
		};
	}

	private async validateLinkedContext(data: Pick<TransactionData, 'area' | 'project'>): Promise<void> {
		await this.validateTypedWikiReference(data.area, 'area', 'Area');
		await this.validateTypedWikiReference(data.project, 'project', 'Project');
	}

	private async validateTypedWikiReference(
		value: string | undefined,
		expectedType: 'area' | 'project',
		label: 'Area' | 'Project',
	): Promise<void> {
		const linkPath = this.extractLinkPath(value);
		if (!linkPath) {
			return;
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
		if (!file) {
			throw new Error(`${label} ${this.formatReferenceLabel(linkPath)} does not exist`);
		}

		const frontmatterType = this.readFrontmatterType(file);
		if (!frontmatterType) {
			throw new Error(
				`${label} ${this.formatReferenceLabel(linkPath)} must have frontmatter type "${expectedType}"`,
			);
		}
		if (frontmatterType !== expectedType) {
			throw new Error(
				`${label} ${this.formatReferenceLabel(linkPath)} points to note with type "${frontmatterType}", expected "${expectedType}"`,
			);
		}
	}

	private extractLinkPath(value: string | undefined): string | null {
		const trimmed = value?.trim();
		if (!trimmed) {
			return null;
		}

		const wikiLinkMatch = trimmed.match(/^\[\[([\s\S]+?)\]\]$/);
		const rawLink = wikiLinkMatch ? wikiLinkMatch[1] : trimmed;
		const linkTarget = rawLink.split('|')[0]?.trim();
		if (!linkTarget) {
			return null;
		}

		return linkTarget.split('#')[0]?.trim() || null;
	}

	private readFrontmatterType(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatterType = cache?.frontmatter?.type;
		return typeof frontmatterType === 'string' ? frontmatterType : null;
	}

	private formatReferenceLabel(linkPath: string): string {
		return `[[${linkPath}]]`;
	}

	private matchesLinkedFile(reference: string | undefined, file: TFile): boolean {
		const linkPath = this.extractLinkPath(reference);
		if (!linkPath) {
			return false;
		}

		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
		return resolved?.path === file.path;
	}
}
