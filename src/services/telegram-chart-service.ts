import { PeriodReport } from '../types';
import { ReportSyncService } from './report-sync-service';

export type TelegramChartType = 'expense-pie' | 'year-trend' | 'balance-trend';

export interface RenderedChartImage {
	bytes: ArrayBuffer;
	fileName: string;
	caption: string;
}

export interface TelegramChartDescriptor {
	type: TelegramChartType;
	label: string;
	description: string;
}

export const TELEGRAM_CHART_DESCRIPTORS: TelegramChartDescriptor[] = [
	{
		type: 'expense-pie',
		label: 'Expense pie',
		description: 'Expense categories for the selected month',
	},
	{
		type: 'year-trend',
		label: 'Year trend',
		description: 'Income vs expenses by month for the report year',
	},
	{
		type: 'balance-trend',
		label: 'Balance trend',
		description: 'Closing balance by month for the report year',
	},
];

export class TelegramChartService {
	constructor(
		private readonly reportSyncService: ReportSyncService,
	) {}

	async renderMonthlyChart(
		report: PeriodReport,
		type: TelegramChartType,
	): Promise<RenderedChartImage | null> {
		if (type === 'expense-pie') {
			return this.renderExpensePieChart(report);
		}
		if (type === 'year-trend') {
			return this.renderYearTrendChart(report.startDate);
		}
		if (type === 'balance-trend') {
			return this.renderBalanceTrendChart(report.startDate);
		}
		return null;
	}

	private async renderExpensePieChart(report: PeriodReport): Promise<RenderedChartImage | null> {
		const entries = report.expenseByCategory.slice(0, 8);
		if (entries.length === 0) {
			return null;
		}

		const canvas = document.createElement('canvas');
		canvas.width = 1200;
		canvas.height = 900;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return null;
		}

		const colors = ['#c2410c', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#1d4ed8', '#9333ea', '#ca8a04'];
		this.paintBackground(ctx, canvas.width, canvas.height);
		this.drawHeader(ctx, 'Expense categories', report.periodLabel);
		this.drawKpiPill(ctx, 80, 150, 250, 62, 'Total expenses', `${this.formatMoney(report.totalExpenses)} RUB`);
		this.drawKpiPill(ctx, 350, 150, 210, 62, 'Transactions', `${report.transactions.filter((item) => item.type === 'expense').length}`);

		const centerX = 320;
		const centerY = 460;
		const radius = 190;
		const total = entries.reduce((sum, entry) => sum + entry.total, 0);

		let startAngle = -Math.PI / 2;
		entries.forEach((entry, index) => {
			const slice = total === 0 ? 0 : (entry.total / total) * Math.PI * 2;
			ctx.beginPath();
			ctx.moveTo(centerX, centerY);
			ctx.fillStyle = colors[index % colors.length];
			ctx.arc(centerX, centerY, radius, startAngle, startAngle + slice);
			ctx.closePath();
			ctx.fill();
			startAngle += slice;
		});

		ctx.beginPath();
		ctx.fillStyle = '#fffdf9';
		ctx.arc(centerX, centerY, 96, 0, Math.PI * 2);
		ctx.fill();
		ctx.beginPath();
		ctx.strokeStyle = '#eadbc8';
		ctx.lineWidth = 2;
		ctx.arc(centerX, centerY, 96, 0, Math.PI * 2);
		ctx.stroke();

		ctx.fillStyle = '#6b4f3c';
		ctx.font = '600 22px "Aptos", "Segoe UI", sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Expenses', centerX, centerY - 12);
		ctx.fillStyle = '#2c1d14';
		ctx.font = '700 30px Georgia, serif';
		ctx.fillText(`${this.formatMoney(report.totalExpenses, 0)} RUB`, centerX, centerY + 24);

		this.drawPanel(ctx, 590, 170, 540, 610, '#fffaf4', '#eadbc8');
		ctx.textAlign = 'left';
		ctx.font = '700 28px Georgia, serif';
		ctx.fillStyle = '#2f241d';
		ctx.fillText('Top categories', 630, 220);

		ctx.font = '500 20px "Aptos", "Segoe UI", sans-serif';
		entries.forEach((entry, index) => {
			const y = 285 + index * 62;
			const color = colors[index % colors.length];
			this.drawRoundedRect(ctx, 630, y - 22, 28, 28, 8, color, color);
			ctx.fillStyle = '#2f241d';
			ctx.font = '600 22px "Aptos", "Segoe UI", sans-serif';
			ctx.fillText(entry.category, 676, y - 2);
			const percentage = total === 0 ? 0 : (entry.total / total) * 100;
			ctx.fillStyle = '#7b6658';
			ctx.font = '500 18px "Aptos", "Segoe UI", sans-serif';
			ctx.fillText(`${this.formatMoney(entry.total)} RUB`, 676, y + 24);
			ctx.textAlign = 'right';
			ctx.fillText(`${percentage.toFixed(1)}%`, 1095, y + 24);
			ctx.textAlign = 'left';
		});

		const bytes = await this.canvasToArrayBuffer(canvas);
		if (!bytes) {
			return null;
		}

		return {
			bytes,
			fileName: `finance-expense-pie-${report.periodKey}.png`,
			caption: `Expense categories for ${report.periodLabel}`,
		};
	}

	private async renderYearTrendChart(reportMonthDate: Date): Promise<RenderedChartImage | null> {
		const year = reportMonthDate.getFullYear();
		const monthlyReports: PeriodReport[] = [];
		for (let month = 0; month < 12; month += 1) {
			monthlyReports.push(
				await this.reportSyncService.generateStandardPeriodReport('month', new Date(year, month, 1)),
			);
		}

		const canvas = document.createElement('canvas');
		canvas.width = 1400;
		canvas.height = 980;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return null;
		}

		this.paintBackground(ctx, canvas.width, canvas.height);
		this.drawHeader(ctx, 'Income vs expenses', `${year}`);

		const layout = this.getTrendChartLayout();
		const chart = {
			left: layout.chartLeft,
			top: layout.chartTop,
			right: layout.chartRight,
			bottom: layout.chartBottom,
		};
		const labels = monthlyReports.map((item) =>
			item.startDate.toLocaleString('en-US', { month: 'short' }),
		);
		const expenseValues = monthlyReports.map((item) => item.totalExpenses);
		const incomeValues = monthlyReports.map((item) => item.totalIncome);
		this.drawKpiPill(ctx, 80, 150, 220, 62, 'Year', `${year}`);
		this.drawKpiPill(
			ctx,
			320,
			150,
			260,
			62,
			'Net result',
			`${this.formatMoney(incomeValues.reduce((sum, value) => sum + value, 0) - expenseValues.reduce((sum, value) => sum + value, 0))} RUB`,
		);
		const maxValue = Math.max(1, ...expenseValues, ...incomeValues);

		this.drawPanel(ctx, layout.panelX, layout.panelY, layout.panelWidth, layout.panelHeight, '#fffaf4', '#eadbc8');
		ctx.strokeStyle = '#e3d2bf';
		ctx.lineWidth = 1;
		for (let step = 0; step <= 5; step += 1) {
			const y = chart.bottom - ((chart.bottom - chart.top) / 5) * step;
			ctx.beginPath();
			ctx.moveTo(chart.left, y);
			ctx.lineTo(chart.right, y);
			ctx.stroke();

			ctx.fillStyle = '#8a7463';
			ctx.font = '500 17px "Aptos", "Segoe UI", sans-serif';
			ctx.textAlign = 'right';
			const value = (maxValue / 5) * step;
			ctx.fillText(this.formatCompactNumber(value), chart.left - 20, y + 6);
		}

		const groupWidth = (chart.right - chart.left) / labels.length;
		const barWidth = Math.min(28, groupWidth / 4);
		labels.forEach((label, index) => {
			const baseX = chart.left + index * groupWidth + groupWidth / 2;
			const expenseHeight = (expenseValues[index] / maxValue) * (chart.bottom - chart.top);
			const incomeHeight = (incomeValues[index] / maxValue) * (chart.bottom - chart.top);

			this.drawRoundedRect(
				ctx,
				baseX - barWidth - 6,
				chart.bottom - expenseHeight,
				barWidth,
				expenseHeight,
				10,
				'#d9485f',
				'#d9485f',
			);
			this.drawRoundedRect(
				ctx,
				baseX + 6,
				chart.bottom - incomeHeight,
				barWidth,
				incomeHeight,
				10,
				'#22a06b',
				'#22a06b',
			);

			ctx.fillStyle = '#4b3a2d';
			ctx.font = '500 17px "Aptos", "Segoe UI", sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(label, baseX, chart.bottom + 34);
		});

		this.drawLegend(ctx, [
			{ color: '#dc2626', label: 'Expenses' },
			{ color: '#16a34a', label: 'Income' },
		], layout.legendX, layout.legendY);

		const bytes = await this.canvasToArrayBuffer(canvas);
		if (!bytes) {
			return null;
		}

		return {
			bytes,
			fileName: `finance-year-trend-${year}.png`,
			caption: `Income vs expenses by month for ${year}`,
		};
	}

	private async renderBalanceTrendChart(reportMonthDate: Date): Promise<RenderedChartImage | null> {
		const year = reportMonthDate.getFullYear();
		const monthlyReports: PeriodReport[] = [];
		for (let month = 0; month < 12; month += 1) {
			monthlyReports.push(
				await this.reportSyncService.generateStandardPeriodReport('month', new Date(year, month, 1)),
			);
		}

		const canvas = document.createElement('canvas');
		canvas.width = 1400;
		canvas.height = 980;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return null;
		}

		this.paintBackground(ctx, canvas.width, canvas.height);
		this.drawHeader(ctx, 'Balance trend', `${year}`);
		const lastKnownBalance = monthlyReports[monthlyReports.length - 1]?.closingBalance ?? 0;
		this.drawKpiPill(ctx, 80, 150, 220, 62, 'Year', `${year}`);
		this.drawKpiPill(ctx, 320, 150, 290, 62, 'Latest balance', `${this.formatMoney(lastKnownBalance)} RUB`);

		const layout = this.getTrendChartLayout();
		const chart = {
			left: layout.chartLeft,
			top: layout.chartTop,
			right: layout.chartRight,
			bottom: layout.chartBottom,
		};
		const labels = monthlyReports.map((item) =>
			item.startDate.toLocaleString('en-US', { month: 'short' }),
		);
		const balances = monthlyReports.map((item) => item.closingBalance);
		const minBalance = Math.min(...balances, 0);
		const maxBalance = Math.max(...balances, 0, 1);
		const range = Math.max(1, maxBalance - minBalance);

		this.drawPanel(ctx, layout.panelX, layout.panelY, layout.panelWidth, layout.panelHeight, '#fffaf4', '#eadbc8');
		ctx.strokeStyle = '#e3d2bf';
		ctx.lineWidth = 1;
		for (let step = 0; step <= 5; step += 1) {
			const y = chart.bottom - ((chart.bottom - chart.top) / 5) * step;
			ctx.beginPath();
			ctx.moveTo(chart.left, y);
			ctx.lineTo(chart.right, y);
			ctx.stroke();

			ctx.fillStyle = '#8a7463';
			ctx.font = '500 17px "Aptos", "Segoe UI", sans-serif';
			ctx.textAlign = 'right';
			const value = minBalance + (range / 5) * step;
			ctx.fillText(this.formatCompactNumber(value), chart.left - 20, y + 6);
		}

		const zeroY = chart.bottom - ((0 - minBalance) / range) * (chart.bottom - chart.top);
		if (zeroY >= chart.top && zeroY <= chart.bottom) {
			ctx.strokeStyle = '#c8aa8f';
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(chart.left, zeroY);
			ctx.lineTo(chart.right, zeroY);
			ctx.stroke();
		}

		const groupWidth = (chart.right - chart.left) / labels.length;
		const pointRadius = 7;
		const points = balances.map((value, index) => {
			const x = chart.left + index * groupWidth + groupWidth / 2;
			const y = chart.bottom - ((value - minBalance) / range) * (chart.bottom - chart.top);
			return { x, y, value };
		});

		const gradient = ctx.createLinearGradient(chart.left, chart.top, chart.right, chart.bottom);
		gradient.addColorStop(0, '#1d4ed8');
		gradient.addColorStop(1, '#0ea5e9');
		ctx.strokeStyle = gradient;
		ctx.lineWidth = 5;

		ctx.beginPath();
		ctx.moveTo(points[0]?.x ?? chart.left, chart.bottom);
		for (const point of points) {
			ctx.lineTo(point.x, point.y);
		}
		ctx.lineTo(points[points.length - 1]?.x ?? chart.right, chart.bottom);
		ctx.closePath();
		const areaGradient = ctx.createLinearGradient(0, chart.top, 0, chart.bottom);
		areaGradient.addColorStop(0, 'rgba(37, 99, 235, 0.18)');
		areaGradient.addColorStop(1, 'rgba(14, 165, 233, 0.02)');
		ctx.fillStyle = areaGradient;
		ctx.fill();

		ctx.beginPath();
		points.forEach((point, index) => {
			if (index === 0) {
				ctx.moveTo(point.x, point.y);
				return;
			}
			ctx.lineTo(point.x, point.y);
		});
		ctx.stroke();

		for (const point of points) {
			ctx.beginPath();
			ctx.fillStyle = '#ffffff';
			ctx.arc(point.x, point.y, pointRadius + 3, 0, Math.PI * 2);
			ctx.fill();
			ctx.beginPath();
			ctx.fillStyle = '#2563eb';
			ctx.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
			ctx.fill();
		}

		labels.forEach((label, index) => {
			const x = chart.left + index * groupWidth + groupWidth / 2;
			ctx.fillStyle = '#4b3a2d';
			ctx.font = '500 17px "Aptos", "Segoe UI", sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(label, x, chart.bottom + 34);
		});

		this.drawLegend(ctx, [
			{ color: '#2563eb', label: 'Closing balance' },
		], layout.legendX, layout.legendY);

		const bytes = await this.canvasToArrayBuffer(canvas);
		if (!bytes) {
			return null;
		}

		return {
			bytes,
			fileName: `finance-balance-trend-${year}.png`,
			caption: `Closing balance by month for ${year}`,
		};
	}

	private paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		const gradient = ctx.createLinearGradient(0, 0, width, height);
		gradient.addColorStop(0, '#fffaf4');
		gradient.addColorStop(0.55, '#f5ebde');
		gradient.addColorStop(1, '#ecdcc8');
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, width, height);

		const glow = ctx.createRadialGradient(1120, 120, 40, 1120, 120, 360);
		glow.addColorStop(0, 'rgba(255, 255, 255, 0.52)');
		glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, width, height);

		const accent = ctx.createRadialGradient(120, 780, 20, 120, 780, 280);
		accent.addColorStop(0, 'rgba(217, 119, 6, 0.12)');
		accent.addColorStop(1, 'rgba(217, 119, 6, 0)');
		ctx.fillStyle = accent;
		ctx.fillRect(0, 0, width, height);
	}

	private drawHeader(ctx: CanvasRenderingContext2D, title: string, subtitle: string): void {
		ctx.fillStyle = '#2f241d';
		ctx.textAlign = 'left';
		ctx.font = '700 42px Georgia, serif';
		ctx.fillText(title, 80, 86);
		ctx.fillStyle = '#7c6a5b';
		ctx.font = '500 22px "Aptos", "Segoe UI", sans-serif';
		ctx.fillText(subtitle, 80, 126);
	}

	private drawLegend(
		ctx: CanvasRenderingContext2D,
		items: Array<{ color: string; label: string }>,
		startX: number,
		y: number,
	): void {
		let x = startX;
		for (const item of items) {
			this.drawRoundedRect(ctx, x, y - 16, 22, 22, 6, item.color, item.color);
			ctx.fillStyle = '#4b3a2d';
			ctx.font = '500 19px "Aptos", "Segoe UI", sans-serif';
			ctx.textAlign = 'left';
			ctx.fillText(item.label, x + 32, y + 2);
			x += 180;
		}
	}

	private getTrendChartLayout(): {
		panelX: number;
		panelY: number;
		panelWidth: number;
		panelHeight: number;
		chartLeft: number;
		chartTop: number;
		chartRight: number;
		chartBottom: number;
		legendX: number;
		legendY: number;
	} {
		return {
			panelX: 70,
			panelY: 245,
			panelWidth: 1260,
			panelHeight: 595,
			chartLeft: 175,
			chartTop: 300,
			chartRight: 1230,
			chartBottom: 735,
			legendX: 110,
			legendY: 890,
		};
	}

	private drawPanel(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		fill: string,
		stroke: string,
	): void {
		this.drawRoundedRect(ctx, x, y, width, height, 26, fill, stroke);
	}

	private drawKpiPill(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		label: string,
		value: string,
	): void {
		this.drawRoundedRect(ctx, x, y, width, height, 18, 'rgba(255, 253, 249, 0.92)', '#eadbc8');
		ctx.textAlign = 'left';
		ctx.fillStyle = '#8a7463';
		ctx.font = '500 15px "Aptos", "Segoe UI", sans-serif';
		ctx.fillText(label.toUpperCase(), x + 18, y + 24);
		ctx.fillStyle = '#2f241d';
		ctx.font = '600 22px "Aptos", "Segoe UI", sans-serif';
		ctx.fillText(value, x + 18, y + 48);
	}

	private drawRoundedRect(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number,
		fill: string,
		stroke?: string,
	): void {
		const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
		ctx.beginPath();
		ctx.moveTo(x + safeRadius, y);
		ctx.lineTo(x + width - safeRadius, y);
		ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
		ctx.lineTo(x + width, y + height - safeRadius);
		ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
		ctx.lineTo(x + safeRadius, y + height);
		ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
		ctx.lineTo(x, y + safeRadius);
		ctx.quadraticCurveTo(x, y, x + safeRadius, y);
		ctx.closePath();
		ctx.fillStyle = fill;
		ctx.fill();
		if (stroke) {
			ctx.strokeStyle = stroke;
			ctx.lineWidth = 1.5;
			ctx.stroke();
		}
	}

	private async canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer | null> {
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) {
			return null;
		}
		return blob.arrayBuffer();
	}

	private formatMoney(value: number, maximumFractionDigits = 2): string {
		return new Intl.NumberFormat('ru-RU', {
			minimumFractionDigits: 0,
			maximumFractionDigits,
		}).format(value);
	}

	private formatCompactNumber(value: number): string {
		const absolute = Math.abs(value);
		if (absolute >= 1_000_000) {
			return `${this.trimTrailingZeroes((value / 1_000_000).toFixed(1))}M`;
		}
		if (absolute >= 1_000) {
			return `${this.trimTrailingZeroes((value / 1_000).toFixed(1))}k`;
		}
		return this.formatMoney(value, 0);
	}

	private trimTrailingZeroes(value: string): string {
		return value.replace(/\.0$/, '');
	}
}
