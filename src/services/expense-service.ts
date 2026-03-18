import { App, TFile, TFolder } from 'obsidian';
import { TransactionData, PeriodReport, CategorySummary } from '../types';
import { 
	generateFrontmatter, 
	generateContentBody, 
	parseFrontmatter,
	parseDetailsFromContent,
	generateFilename 
} from '../utils/frontmatter';

export class ExpenseService {
	private app: App;
	private settingsFolder: string;

	constructor(app: App, expenseFolder: string) {
		this.app = app;
		this.settingsFolder = expenseFolder;
	}

	/**
	 * Create a new transaction file
	 */
	async createTransaction(data: TransactionData): Promise<TFile> {
		// Ensure expense folder exists
		await this.ensureExpenseFolder();

		// Generate filename and content
        console.log('Creating transaction file with data:', data);
		const filename = generateFilename(data);
		const filepath = `${this.settingsFolder}/${filename}`;
		
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
		const expenseFolder = this.app.vault.getAbstractFileByPath(this.settingsFolder);
		
		if (!expenseFolder || !(expenseFolder instanceof TFolder)) {
			return [];
		}

		const files = expenseFolder.children.filter(f => f instanceof TFile && f.extension === 'md');
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
				type: frontmatter.type as 'expense' | 'income',
				amount: Number(frontmatter.amount),
				currency: (frontmatter.currency as string) || 'RUB',
				dateTime: frontmatter.dateTime as string,
				comment: frontmatter.comment as string || '',
				tags: (frontmatter.tags as string[]) || [],
				category: frontmatter.category as string,
				details: details,
				source: (frontmatter.source as any) || 'manual',
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
		const folder = this.app.vault.getAbstractFileByPath(this.settingsFolder);
		
		if (!folder) {
			await this.app.vault.createFolder(this.settingsFolder);
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
		// Ensure reports folder exists
		const reportsFolder = `${this.settingsFolder}/Reports`;
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
}
