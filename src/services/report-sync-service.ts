import { App, TAbstractFile, TFile } from 'obsidian';
import { ExpenseManagerSettings } from '../settings';
import { ExpenseService } from './expense-service';
import { PeriodReport, ReportPeriodDescriptor } from '../types';
import {
	createCustomPeriodDescriptor,
	enumeratePeriodsInRange,
	getEnabledAutoPeriodKinds,
	getPeriodDescriptorForDate,
} from '../utils/report-periods';

export class ReportSyncService {
	private syncTimer: number | null = null;
	private syncInProgress = false;

	constructor(
		private readonly app: App,
		private readonly expenseService: ExpenseService,
		private readonly settings: ExpenseManagerSettings,
	) {}

	async initialize(): Promise<void> {
		await this.syncAutoReports();
	}

	destroy(): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}

	scheduleAutoSync(_reason: string): void {
		if (!this.settings.autoSyncReportsOnVaultChanges) {
			return;
		}

		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
		}

		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.syncAutoReports();
		}, 750);
	}

	shouldSyncForFile(file: TAbstractFile | null): file is TFile {
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return false;
		}

		return this.expenseService.isTransactionFile(file) || this.expenseService.isReportFile(file);
	}

	async syncAutoReports(): Promise<TFile[]> {
		if (this.syncInProgress) {
			return [];
		}

		const enabledKinds = getEnabledAutoPeriodKinds(this.settings);
		if (enabledKinds.length === 0) {
			return [];
		}

		this.syncInProgress = true;
		try {
			const allTransactions = await this.expenseService.getAllTransactions();
			const now = new Date();
			const earliestDate = allTransactions.length > 0
				? new Date(
					Math.min(
						...allTransactions.map((transaction) => new Date(transaction.dateTime).getTime()),
					),
				)
				: now;
			const savedFiles: TFile[] = [];

			for (const kind of enabledKinds) {
				const descriptors = enumeratePeriodsInRange(kind, earliestDate, now, true);
				for (const descriptor of descriptors) {
					const budget = await this.expenseService.getExistingBudgetForDescriptor(descriptor);
					const report = this.expenseService.buildPeriodReportFromTransactions(
						allTransactions,
						descriptor,
						budget,
					);
					const file = await this.expenseService.upsertReportFile(report);
					savedFiles.push(file);
				}
			}

			return savedFiles;
		} finally {
			this.syncInProgress = false;
		}
	}

	async generateCurrentMonthReport(): Promise<PeriodReport> {
		return this.generateStandardPeriodReport('month', new Date());
	}

	async generateStandardPeriodReport(
		kind: 'month' | 'quarter' | 'half-year' | 'year',
		date: Date,
	): Promise<PeriodReport> {
		const descriptor = getPeriodDescriptorForDate(kind, date);
		return this.generateReportForDescriptor(descriptor);
	}

	async generateCustomReport(startDate: Date, endDate: Date): Promise<PeriodReport> {
		return this.generateReportForDescriptor(createCustomPeriodDescriptor(startDate, endDate));
	}

	async saveReportForDescriptor(descriptor: ReportPeriodDescriptor): Promise<TFile> {
		const report = await this.generateReportForDescriptor(descriptor);
		return this.expenseService.upsertReportFile(report);
	}

	private async generateReportForDescriptor(descriptor: ReportPeriodDescriptor): Promise<PeriodReport> {
		const allTransactions = await this.expenseService.getAllTransactions();
		const budget = await this.expenseService.getExistingBudgetForDescriptor(descriptor);
		return this.expenseService.buildPeriodReportFromTransactions(allTransactions, descriptor, budget);
	}
}
