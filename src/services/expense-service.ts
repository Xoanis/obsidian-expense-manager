import { App, TFile, TFolder } from 'obsidian';
import { TransactionData, PeriodReport, CategorySummary, FinanceContextSummary } from '../types';
import { ExpenseManagerSettings } from '../settings';
import { IParaCoreApi, RegisteredParaDomain } from '../integrations/para-core/types';
import { 
	generateFrontmatter, 
	generateContentBody, 
	parseFrontmatter,
	parseDetailsFromContent,
	generateFilename 
} from '../utils/frontmatter';

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

		if (this.canUseParaCoreRecords()) {
			return this.createTransactionViaParaCore(data);
		}

		// Ensure expense folder exists
		await this.ensureExpenseFolder();

		// Generate filename and content
        console.log('Creating transaction file with data:', data);
		const filename = generateFilename(data);
		const filepath = `${this.settings.expenseFolder}/${filename}`;
		
		const frontmatter = generateFrontmatter(data);
		const contentBody = generateContentBody(data);
		const fullContent = frontmatter + contentBody;

		// Create the file
		const file = await this.app.vault.create(filepath, fullContent);
		
		return file;
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
			const frontmatter = parseFrontmatter(content);
			
			if (!frontmatter || !frontmatter.type || !frontmatter.amount) {
				return null;
			}

			const details = parseDetailsFromContent(content);

			return {
				id: file.path,
				type: this.normalizeTransactionType(frontmatter.type as string),
				amount: Number(frontmatter.amount),
				currency: (frontmatter.currency as string) || 'RUB',
				dateTime: frontmatter.dateTime as string,
				comment: frontmatter.comment as string || '',
				area: frontmatter.area as string | undefined,
				project: frontmatter.project as string | undefined,
				tags: (frontmatter.tags as string[]) || [],
				category: frontmatter.category as string,
				details: details,
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
		const transactions = await this.getTransactionsByPeriod(startDate, endDate);
		
		let totalExpenses = 0;
		let totalIncome = 0;
		const categoryMap = new Map<string, { total: number; count: number }>();

		for (const t of transactions) {
			if (t.type === 'expense') {
				totalExpenses += t.amount;
			} else {
				totalIncome += t.amount;
			}

			// Group by category
			const category = t.category || 'uncategorized';
			const existing = categoryMap.get(category) || { total: 0, count: 0 };
			existing.total += t.amount;
			existing.count += 1;
			categoryMap.set(category, existing);
		}

		// Convert to CategorySummary array
		const byCategory: CategorySummary[] = Array.from(categoryMap.entries()).map(([category, data]) => ({
			category,
			total: data.total,
			count: data.count,
			percentage: 0 // Will be calculated later
		}));

		// Calculate percentages
		const grandTotal = totalExpenses + totalIncome;
		for (const cat of byCategory) {
			cat.percentage = grandTotal > 0 ? (cat.total / grandTotal) * 100 : 0;
		}

		return {
			startDate,
			endDate,
			totalExpenses,
			totalIncome,
			balance: totalIncome - totalExpenses,
			transactions,
			byCategory
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
	async isDuplicateTransaction(fn: string | undefined, fd: string | undefined, fp: string | undefined, dateTime: string): Promise<boolean> {
		// Only check if we have at least one fiscal identifier
		if (!fn && !fd && !fp) {
			return false;
		}

		const allTransactions = await this.getAllTransactions();
		const transactionDate = new Date(dateTime).toDateString();

		for (const t of allTransactions) {
			// Check if date matches (same day)
			const existingDate = new Date(t.dateTime).toDateString();
			if (existingDate !== transactionDate) {
				continue;
			}

			// Check if fiscal identifiers match
			const fnMatch = fn && t.fn && t.fn === fn;
			const fdMatch = fd && t.fd && t.fd === fd;
			const fpMatch = fp && t.fp && t.fp === fp;

			// If all provided identifiers match, it's a duplicate
			if (fnMatch || fdMatch || fpMatch) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Generate markdown content for period report
	 */
	generateReportMarkdown(report: PeriodReport): string {
		const formatDate = (date: Date): string => {
			return date.toISOString().split('T')[0];
		};

		let content = `---\ntype: financial-report\nperiod: ${formatDate(report.startDate)} to ${formatDate(report.endDate)}\ngeneratedAt: ${new Date().toISOString()}\ntotalExpenses: ${report.totalExpenses.toFixed(2)}\ntotalIncome: ${report.totalIncome.toFixed(2)}\nbalance: ${report.balance.toFixed(2)}\n---\n\n`;

		// Header
		content += `# Financial Report\n\n`;
		content += `**Period:** ${formatDate(report.startDate)} - ${formatDate(report.endDate)}\n\n`;
		content += `**Generated:** ${new Date().toLocaleString()}\n\n`;

		// Summary section
		content += `## 📊 Summary\n\n`;
		content += `| Metric | Amount |\n`;
		content += `|--------|--------|\n`;
		content += `| 💰 Total Income | ${report.totalIncome.toFixed(2)} RUB |\n`;
		content += `| 💸 Total Expenses | ${report.totalExpenses.toFixed(2)} RUB |\n`;
		content += `| 📈 Balance | ${report.balance.toFixed(2)} RUB |\n\n`;

		// Category breakdown
		content += `## 📋 Category Breakdown\n\n`;
		content += `| Category | Amount | % | Count |\n`;
		content += `|----------|--------|---|-------|\n`;

		// Sort by total descending
		const sortedCategories = [...report.byCategory].sort((a, b) => b.total - a.total);
		for (const cat of sortedCategories) {
			content += `| ${cat.category} | ${cat.total.toFixed(2)} RUB | ${cat.percentage.toFixed(1)}% | ${cat.count} |\n`;
		}
		content += '\n';

		// Transactions by type
		content += `## 💰 Income\n\n`;
		const incomes = report.transactions.filter(t => t.type === 'income');
		if (incomes.length > 0) {
			content += `| Date | Amount | Comment | Category |\n`;
			content += `|------|--------|---------|----------|\n`;
			for (const t of incomes) {
				const dateStr = new Date(t.dateTime).toLocaleDateString();
				content += `| ${dateStr} | ${t.amount.toFixed(2)} ${t.currency} | ${t.comment} | ${t.category} |\n`;
			}
		} else {
			content += `_No income in this period._\n\n`;
		}
		content += '\n';

		content += `## 💸 Expenses\n\n`;
		const expenses = report.transactions.filter(t => t.type === 'expense');
		if (expenses.length > 0) {
			content += `| Date | Amount | Comment | Category |\n`;
			content += `|------|--------|---------|----------|\n`;
			for (const t of expenses) {
				const dateStr = new Date(t.dateTime).toLocaleDateString();
				content += `| ${dateStr} | ${t.amount.toFixed(2)} ${t.currency} | ${t.comment} | ${t.category} |\n`;
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
		if (this.canUseParaCoreRecords()) {
			return this.saveReportViaParaCore(report);
		}

		// Ensure reports folder exists
		const reportsFolder = `${this.settings.expenseFolder}/Reports`;
		const folder = this.app.vault.getAbstractFileByPath(reportsFolder);
		if (!folder) {
			await this.app.vault.createFolder(reportsFolder);
		}

		// Generate filename
		const startDate = report.startDate.toISOString().split('T')[0];
		const endDate = report.endDate.toISOString().split('T')[0];
		const filename = `financial-report-${startDate}-to-${endDate}.md`;
		const filepath = `${reportsFolder}/${filename}`;

		// Generate content
		const content = this.generateReportMarkdown(report);

		// Create file
		const file = await this.app.vault.create(filepath, content);
		
		return file;
	}

	private async createTransactionViaParaCore(data: TransactionData): Promise<TFile> {
		if (!this.paraCoreApi) {
			throw new Error('PARA Core API is not available');
		}

		const type = data.type === 'expense' ? 'finance-expense' : 'finance-income';
		const filename = generateFilename(data).replace(/\.md$/i, '');
		const date = data.dateTime.split('T')[0] || new Date(data.dateTime).toISOString().split('T')[0];
		const tags = Array.from(new Set(['finance', data.type, ...data.tags]));

		return this.paraCoreApi.createNote({
			type,
			title: data.comment || filename,
			fileNameOverride: filename,
			openAfterCreate: false,
			frontmatterOverrides: {
				date,
				dateTime: data.dateTime,
				amount: data.amount,
				currency: data.currency,
				comment: data.comment,
				area: data.area ?? null,
				project: data.project ?? null,
				category: data.category || data.tags[0] || 'uncategorized',
				source: data.source,
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

		const startDate = report.startDate.toISOString().split('T')[0];
		const endDate = report.endDate.toISOString().split('T')[0];
		const title = `Financial Report ${startDate} to ${endDate}`;
		const filename = `financial-report-${startDate}-to-${endDate}`;

		return this.paraCoreApi.createNote({
			type: 'finance-report',
			title,
			fileNameOverride: filename,
			openAfterCreate: false,
			frontmatterOverrides: {
				periodStart: startDate,
				periodEnd: endDate,
				currency: this.settings.defaultCurrency,
				totalExpenses: report.totalExpenses,
				totalIncome: report.totalIncome,
				balance: report.balance,
				tags: ['finance', 'report'],
				report,
			},
		});
	}

	private getTransactionFiles(): TFile[] {
		const folders = [this.settings.expenseFolder];
		if (this.financeDomain) {
			folders.push(`${this.financeDomain.recordsPath}/Transactions`);
		}

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
