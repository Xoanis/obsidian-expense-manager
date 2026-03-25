import { App, TFile, TFolder } from 'obsidian';
import {
	TransactionData,
	PeriodReport,
	CategorySummary,
	FinanceContextSummary,
	ReportPeriodDescriptor,
	ReportPeriodKind,
	ReportBudgetSummary,
	ReportBudgetAlertLevel,
	ReportBudgetAlertState,
} from '../types';
import { ExpenseManagerSettings } from '../settings';
import { IParaCoreApi, RegisteredParaDomain } from '../integrations/para-core/types';
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

export class ExpenseService {
	private app: App;
	private settings: ExpenseManagerSettings;
	private paraCoreApi: IParaCoreApi | null;
	private financeDomain: RegisteredParaDomain | null;

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
        console.log('Creating transaction file with data:', dataWithArtifact);
		const filename = generateFilename(dataWithArtifact);
		const filepath = `${this.settings.expenseFolder}/${filename}`;
		
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

		const folderPath = await this.ensureFolderPath(this.getArtifactsFolderPath());
		const sanitizedName = data.artifactFileName.replace(/[\\/:*?"<>|]/g, '-');
		const artifactPath = await this.getAvailableArtifactPath(folderPath, sanitizedName);
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
				console.error(`Error parsing file ${file.path}:`, error);
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
			console.error(`Error parsing transaction file ${file.path}:`, error);
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
		const folder = this.app.vault.getAbstractFileByPath(this.settings.expenseFolder);
		
		if (!folder) {
			await this.app.vault.createFolder(this.settings.expenseFolder);
		}
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

		const frontmatterLines = [
			'---',
			'type: "finance-report"',
			`periodKind: "${report.periodKind}"`,
			`periodKey: "${report.periodKey}"`,
			`periodLabel: "${report.periodLabel.replace(/"/g, '\\"')}"`,
			`periodStart: ${formatDate(report.startDate)}`,
			`periodEnd: ${formatDate(report.endDate)}`,
			`generatedAt: ${generatedAt}`,
			`currency: "${currency}"`,
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
			'tags: ["finance","report"]',
			'---',
			'',
		];
		let content = `${frontmatterLines.join('\n')}`;

		content += this.renderCategorySection('💸 Expense categories', report.expenseByCategory);
		content += this.renderCategorySection('💰 Income categories', report.incomeByCategory);
		content += this.renderMermaidPieSection('💸 Expense pie chart', report.expenseByCategory);
		content += this.renderMermaidPieSection('💰 Income pie chart', report.incomeByCategory);
		content += this.renderMonthlyTrendSection(report);

		// Transactions by type
		content += `## 💰 Income\n\n`;
		const incomes = report.transactions.filter(t => t.type === 'income');
		if (incomes.length > 0) {
			content += `| Date | Amount | Description | Category |\n`;
			content += `|------|--------|---------|----------|\n`;
			for (const t of incomes) {
				const dateStr = new Date(t.dateTime).toLocaleDateString();
				content += `| ${dateStr} | ${t.amount.toFixed(2)} ${t.currency} | ${t.description} | ${t.category} |\n`;
			}
		} else {
			content += `_No income in this period._\n\n`;
		}
		content += '\n';

		content += `## 💸 Expenses\n\n`;
		const expenses = report.transactions.filter(t => t.type === 'expense');
		if (expenses.length > 0) {
			content += `| Date | Amount | Description | Category |\n`;
			content += `|------|--------|---------|----------|\n`;
			for (const t of expenses) {
				const dateStr = new Date(t.dateTime).toLocaleDateString();
				content += `| ${dateStr} | ${t.amount.toFixed(2)} ${t.currency} | ${t.description} | ${t.category} |\n`;
			}
		} else {
			content += `_No expenses in this period._\n\n`;
		}

		return content;
	}

	/**
	 * Save report as markdown file
	 */
	async saveReportAsFile(report: PeriodReport): Promise<TFile> {
		return this.upsertReportFile(report);
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

	private async saveReportViaParaCore(report: PeriodReport): Promise<TFile> {
		if (!this.paraCoreApi) {
			throw new Error('PARA Core API is not available');
		}

		const startDate = formatDateKey(report.startDate);
		const endDate = formatDateKey(report.endDate);
		const title = report.periodKind === 'custom'
			? `Financial Report ${startDate} to ${endDate}`
			: `Financial Report ${report.periodLabel}`;
		const filename = this.getReportFileName(report).replace(/\.md$/i, '');

		return this.paraCoreApi.createNote({
			type: 'finance-report',
			title,
			fileNameOverride: filename,
			openAfterCreate: false,
			frontmatterOverrides: {
				periodStart: startDate,
				periodEnd: endDate,
				currency: this.settings.defaultCurrency,
				periodKind: report.periodKind,
				periodKey: report.periodKey,
				periodLabel: report.periodLabel,
				openingBalance: report.openingBalance,
				totalExpenses: report.totalExpenses,
				totalIncome: report.totalIncome,
				netChange: report.netChange,
				closingBalance: report.closingBalance,
				balance: report.balance,
				budget: report.budget?.limit ?? null,
				tags: ['finance', 'report'],
			},
		});
	}

	async upsertReportFile(
		report: PeriodReport,
		options?: {
			existingFile?: TFile | null;
		},
	): Promise<TFile> {
		const existing = options?.existingFile ?? await this.findReportFile(report.periodKind, report.startDate, report.endDate);
		const existingBudget = existing ? await this.readReportBudget(existing) : report.budget?.limit ?? null;
		const existingAlertState = existing ? await this.readReportBudgetAlertState(existing) : this.createEmptyBudgetAlertState();
		const reportForSave = this.applyPersistedBudgetState(report, existingBudget, existingAlertState);

		if (existing) {
			const desiredPath = `${existing.parent?.path ?? ''}/${this.getReportFileName(reportForSave)}`.replace(/^\/+/, '');
			if (existing.path !== desiredPath && !this.app.vault.getAbstractFileByPath(desiredPath)) {
				await this.app.fileManager.renameFile(existing, desiredPath);
			}

			const currentContent = await this.app.vault.cachedRead(existing);
			const existingGeneratedAt = this.readGeneratedAt(currentContent) ?? new Date().toISOString();
			const stableContent = this.generateReportMarkdown(reportForSave, existingGeneratedAt);
			if (currentContent !== stableContent) {
				const updatedContent = this.generateReportMarkdown(reportForSave, new Date().toISOString());
				await this.app.vault.modify(existing, updatedContent);
			}
			return existing;
		}

		const content = this.generateReportMarkdown(reportForSave);

		if (this.canUseParaCoreRecords()) {
			try {
				const file = await this.saveReportViaParaCore(reportForSave);
				await this.app.vault.modify(file, content);
				return file;
			} catch (error) {
				console.warn('Falling back to direct report file creation:', error);
			}
		}

		const reportsFolder = await this.ensureFolderPath(this.getReportsFolderPath());
		const filepath = `${reportsFolder}/${this.getReportFileName(reportForSave)}`;
		return this.app.vault.create(filepath, content);
	}

	async findReportFile(
		periodKind: ReportPeriodKind,
		startDate: Date,
		endDate: Date,
	): Promise<TFile | null> {
		const reportFiles = this.getReportFiles();
		const targetStart = formatDateKey(startDate);
		const targetEnd = formatDateKey(endDate);

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
			const fileKind = typeof frontmatter.periodKind === 'string'
				? frontmatter.periodKind
				: (fileStart && fileEnd ? 'custom' : null);

			if (fileStart === targetStart && fileEnd === targetEnd && fileKind === periodKind) {
				return file;
			}
			if (fileStart === targetStart && fileEnd === targetEnd && periodKind === 'custom') {
				return file;
			}
		}

		return null;
	}

	async getExistingBudgetForDescriptor(descriptor: ReportPeriodDescriptor): Promise<number | null> {
		const reportFile = await this.findReportFile(descriptor.kind, descriptor.startDate, descriptor.endDate);
		if (!reportFile) {
			return null;
		}
		return this.readReportBudget(reportFile);
	}

	isTransactionFile(file: TFile): boolean {
		return this.getTransactionFolderPaths().some((folderPath) => file.parent?.path === folderPath);
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

	private getTransactionFolderPaths(): string[] {
		const folders = [this.settings.expenseFolder];
		if (this.financeDomain) {
			folders.push(`${this.financeDomain.recordsPath}/Transactions`);
		}
		return folders;
	}

	private getReportFolderPaths(): string[] {
		return [this.getReportsFolderPath()];
	}

	private getArtifactsFolderPath(): string {
		if (this.financeDomain) {
			return `${this.financeDomain.recordsPath}/Artifacts`;
		}
		return `${this.settings.expenseFolder}/Artifacts`;
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
				await this.app.vault.createFolder(currentPath);
			}
		}
		return folderPath;
	}

	private async getAvailableArtifactPath(folderPath: string, fileName: string): Promise<string> {
		const lastDot = fileName.lastIndexOf('.');
		const baseName = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
		const extension = lastDot > 0 ? fileName.slice(lastDot) : '';
		let attempt = 0;

		while (true) {
			const candidateName = attempt === 0 ? `${baseName}${extension}` : `${baseName}-${attempt}${extension}`;
			const candidatePath = `${folderPath}/${candidateName}`;
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

			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === 'md') {
					filesByPath.set(child.path, child);
				}
			}
		}

		return [...filesByPath.values()];
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
