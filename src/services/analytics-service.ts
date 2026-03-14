import { ExpenseService } from './expense-service';
import { PeriodReport, ChartData } from '../types';

export class AnalyticsService {
	private expenseService: ExpenseService;

	constructor(expenseService: ExpenseService) {
		this.expenseService = expenseService;
	}

	/**
	 * Generate report for current month
	 */
	async generateCurrentMonthReport(): Promise<PeriodReport> {
		const now = new Date();
		const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
		const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

		return this.expenseService.generatePeriodReport(startDate, endDate);
	}

	/**
	 * Generate report for last month
	 */
	async generateLastMonthReport(): Promise<PeriodReport> {
		const now = new Date();
		const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		const endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

		return this.expenseService.generatePeriodReport(startDate, endDate);
	}

	/**
	 * Generate report for custom period
	 */
	async generateCustomPeriodReport(startDate: Date, endDate: Date): Promise<PeriodReport> {
		return this.expenseService.generatePeriodReport(startDate, endDate);
	}

	/**
	 * Generate chart data for category breakdown
	 */
	async generateCategoryChartData(startDate: Date, endDate: Date): Promise<ChartData> {
		const report = await this.expenseService.generatePeriodReport(startDate, endDate);
		
		const labels = report.byCategory.map(c => c.category);
		const values = report.byCategory.map(c => c.total);
		
		// Generate colors
		const colors = this.generateColors(report.byCategory.length);

		return {
			labels,
			values,
			colors
		};
	}

	/**
	 * Generate chart data for monthly trend
	 */
	async generateMonthlyTrendChart(months: number = 6): Promise<ChartData> {
		const now = new Date();
		const labels: string[] = [];
		const values: number[] = [];

		for (let i = months - 1; i >= 0; i--) {
			const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
			const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
			const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59);

			const report = await this.expenseService.generatePeriodReport(monthStart, monthEnd);
			
			const monthName = monthDate.toLocaleString('en-US', { month: 'short' });
			labels.push(monthName);
			values.push(report.totalExpenses);
		}

		return {
			labels,
			values
		};
	}

	/**
	 * Get spending statistics
	 */
	async getSpendingStats(): Promise<{
		averageDaily: number;
		averageMonthly: number;
		highestExpense: number;
		totalTransactions: number;
	}> {
		const transactions = await this.expenseService.getAllTransactions();
		const expenses = transactions.filter(t => t.type === 'expense');

		if (expenses.length === 0) {
			return {
				averageDaily: 0,
				averageMonthly: 0,
				highestExpense: 0,
				totalTransactions: 0
			};
		}

		// Calculate date range
		const dates = expenses.map(t => new Date(t.dateTime).getTime());
		const minDate = Math.min(...dates);
		const maxDate = Math.max(...dates);
		const daysDiff = Math.max(1, (maxDate - minDate) / (1000 * 60 * 60 * 24));

		const totalExpenses = expenses.reduce((sum, t) => sum + t.amount, 0);
		const highestExpense = Math.max(...expenses.map(t => t.amount));

		return {
			averageDaily: totalExpenses / daysDiff,
			averageMonthly: (totalExpenses / daysDiff) * 30,
			highestExpense,
			totalTransactions: expenses.length
		};
	}

	/**
	 * Generate colors for charts
	 */
	private generateColors(count: number): string[] {
		const colors = [
			'rgba(255, 99, 132, 0.7)',    // Red
			'rgba(54, 162, 235, 0.7)',    // Blue
			'rgba(255, 206, 86, 0.7)',    // Yellow
			'rgba(75, 192, 192, 0.7)',    // Teal
			'rgba(153, 102, 255, 0.7)',   // Purple
			'rgba(255, 159, 64, 0.7)',    // Orange
			'rgba(199, 199, 199, 0.7)',   // Grey
			'rgba(83, 102, 255, 0.7)',    // Blue-purple
			'rgba(255, 99, 255, 0.7)',    // Pink
			'rgba(99, 255, 132, 0.7)'     // Green
		];

		const result: string[] = [];
		for (let i = 0; i < count; i++) {
			result.push(colors[i % colors.length]);
		}

		return result;
	}
}
