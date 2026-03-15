import { App, Modal, Setting, Notice } from 'obsidian';
import { PeriodReport, CategorySummary } from '../types';
import { formatDateTime } from '../utils/frontmatter';
import { ExpenseService } from '../services/expense-service';

export class ReportsModal extends Modal {
	private report: PeriodReport | null = null;
	private expenseService: ExpenseService;

	onComplete: (() => void) | null = null;

	constructor(app: App, report: PeriodReport, expenseService: ExpenseService) {
		super(app);
		this.report = report;
		this.expenseService = expenseService;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		if (!this.report) return;

		// Header
		contentEl.createEl('h2', { text: 'Financial Report' });

		// Period info
		const periodInfo = contentEl.createDiv({ cls: 'period-info' });
		periodInfo.style.cssText = 'margin-bottom: 20px; padding: 10px; background: var(--background-secondary); border-radius: 8px;';
		periodInfo.createEl('p', { 
			text: `Period: ${formatDateTime(this.report.startDate.toISOString())} - ${formatDateTime(this.report.endDate.toISOString())}` 
		});

		// Summary cards
		const summaryContainer = contentEl.createDiv({ cls: 'summary-cards' });
		summaryContainer.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 30px;';

		// Income card
		const incomeCard = summaryContainer.createDiv({ cls: 'summary-card income' });
		incomeCard.style.cssText = 'padding: 15px; background: var(--background-modifier-success); border-radius: 8px; color: white;';
		incomeCard.createEl('div', { text: '💰 Total Income' });
		incomeCard.createEl('div', { 
			text: `${this.report.totalIncome.toFixed(2)} RUB`,
			cls: 'mod-xl'
		});

		// Expense card
		const expenseCard = summaryContainer.createDiv({ cls: 'summary-card expense' });
		expenseCard.style.cssText = 'padding: 15px; background: var(--background-modifier-error); border-radius: 8px; color: white;';
		expenseCard.createEl('div', { text: '💸 Total Expenses' });
		expenseCard.createEl('div', { 
			text: `${this.report.totalExpenses.toFixed(2)} RUB`,
			cls: 'mod-xl'
		});

		// Balance card
		const balanceCard = summaryContainer.createDiv({ cls: 'summary-card balance' });
		balanceCard.style.cssText = `padding: 15px; background: ${this.report.balance >= 0 ? 'var(--background-modifier-success)' : 'var(--background-modifier-error)'}; border-radius: 8px; color: white;`;
		balanceCard.createEl('div', { text: '📊 Balance' });
		balanceCard.createEl('div', { 
			text: `${this.report.balance.toFixed(2)} RUB`,
			cls: 'mod-xl'
		});

		// Category breakdown table
		contentEl.createEl('h3', { text: 'Category Breakdown' });

		const tableContainer = contentEl.createDiv({ cls: 'category-table-container' });
		tableContainer.style.cssText = 'overflow-x: auto;';

		const table = tableContainer.createEl('table');
		table.className = 'data-grid';
		
		// Table header
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: 'Category' });
		headerRow.createEl('th', { text: 'Amount' });
		headerRow.createEl('th', { text: '%' });
		headerRow.createEl('th', { text: 'Count' });

		// Table body
		const tbody = table.createEl('tbody');
		
		// Sort by total descending
		const sortedCategories = [...this.report.byCategory].sort((a, b) => b.total - a.total);

		for (const cat of sortedCategories) {
			const row = tbody.createEl('tr');
			row.createEl('td', { text: cat.category });
			row.createEl('td', { text: `${cat.total.toFixed(2)} RUB` });
			row.createEl('td', { text: `${cat.percentage.toFixed(1)}%` });
			row.createEl('td', { text: cat.count.toString() });
		}

		// Transactions list
		contentEl.createEl('h3', { text: 'Transactions' });
		
		const transactionsContainer = contentEl.createDiv({ 
			cls: 'transactions-list',
			attr: {
				style: 'max-height: 400px; overflow-y: auto;'
			}
		});

		// Group by type
		const expenses = this.report.transactions.filter(t => t.type === 'expense');
		const incomes = this.report.transactions.filter(t => t.type === 'income');

		// Income section
		if (incomes.length > 0) {
			transactionsContainer.createEl('h4', { text: '💰 Income' });
			for (const t of incomes) {
				const item = transactionsContainer.createDiv({ 
					cls: 'transaction-item',
					attr: {
						style: 'display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--background-modifier-border);'
					}
				});
				item.createEl('div', { text: `${t.comment} (${formatDateTime(t.dateTime)})` });
				item.createEl('div', { 
					text: `+${t.amount.toFixed(2)} ${t.currency}`,
					attr: {
						style: 'color: var(--text-success); font-weight: bold;'
					}
				});
			}
		}

		// Expense section
		if (expenses.length > 0) {
			transactionsContainer.createEl('h4', { text: '💸 Expenses' });
			for (const t of expenses) {
				const item = transactionsContainer.createDiv({ 
					cls: 'transaction-item',
					attr: {
						style: 'display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--background-modifier-border);'
					}
				});
				item.createEl('div', { text: `${t.comment} (${formatDateTime(t.dateTime)})` });
				item.createEl('div', { 
					text: `-${t.amount.toFixed(2)} ${t.currency}`,
					attr: {
						style: 'color: var(--text-error); font-weight: bold;'
					}
				});
			}
		}

		// Close button
		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText('Save as File')
					.setCta()
					.onClick(async () => {
						try {
							const file = await this.expenseService.saveReportAsFile(this.report!);
							new Notice(`Report saved to ${file.path}`);
							// Open the file
							const leaf = this.app.workspace.getLeaf();
							await leaf.openFile(file);
						} catch (error) {
							new Notice(`Error saving report: ${(error as Error).message}`);
							console.error('Save error:', error);
						}
					});
			})
			.addButton(button => {
				button
					.setButtonText('Close')
					.onClick(() => {
						this.close();
					});
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
