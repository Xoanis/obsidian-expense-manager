import { App, TFile } from 'obsidian';
import { ExpenseService } from './expense-service';
import { ReportSyncService } from './report-sync-service';
import { generateContentBody, generateFrontmatter, parseYamlFrontmatter } from '../utils/frontmatter';
import {
	createCustomPeriodDescriptor,
	formatDateKey,
	getPeriodDescriptorForDate,
} from '../utils/report-periods';
import { ReportPeriodDescriptor, ReportPeriodKind, TransactionData } from '../types';

export interface MigrationSummary {
	transactionNotesUpdated: number;
	reportNotesUpdated: number;
	reportNotesRenamed: number;
}

export class MigrationService {
	constructor(
		private readonly app: App,
		private readonly expenseService: ExpenseService,
		private readonly reportSyncService: ReportSyncService,
	) {}

	async migrateLegacyNotes(): Promise<MigrationSummary> {
		const summary: MigrationSummary = {
			transactionNotesUpdated: 0,
			reportNotesUpdated: 0,
			reportNotesRenamed: 0,
		};

		for (const file of this.expenseService.listTransactionFiles()) {
			const changed = await this.migrateTransactionFile(file);
			if (changed) {
				summary.transactionNotesUpdated += 1;
			}
		}

		const allTransactions = await this.expenseService.getAllTransactions();
		for (const file of this.expenseService.listReportFiles()) {
			const result = await this.migrateReportFile(file, allTransactions);
			if (result.updated) {
				summary.reportNotesUpdated += 1;
			}
			if (result.renamed) {
				summary.reportNotesRenamed += 1;
			}
		}

		await this.reportSyncService.syncAutoReports();
		return summary;
	}

	private async migrateTransactionFile(file: TFile): Promise<boolean> {
		const transaction = await this.expenseService.parseTransactionFile(file);
		if (!transaction) {
			return false;
		}

		const normalized: TransactionData = {
			...transaction,
			description: transaction.description || transaction.comment || '',
			comment: undefined,
		};
		const nextContent = generateFrontmatter(normalized) + generateContentBody(normalized);
		const currentContent = await this.app.vault.cachedRead(file);
		if (currentContent === nextContent) {
			return false;
		}

		await this.app.vault.modify(file, nextContent);
		return true;
	}

	private async migrateReportFile(
		file: TFile,
		allTransactions: TransactionData[],
	): Promise<{ updated: boolean; renamed: boolean }> {
		const oldPath = file.path;
		const currentContent = await this.app.vault.cachedRead(file);
		const frontmatter = parseYamlFrontmatter(currentContent);
		if (!frontmatter) {
			return { updated: false, renamed: false };
		}

		const type = typeof frontmatter.type === 'string' ? frontmatter.type : '';
		if (type !== 'finance-report' && type !== 'financial-report') {
			return { updated: false, renamed: false };
		}

		const periodDescriptor = this.inferReportDescriptor(frontmatter);
		if (!periodDescriptor) {
			return { updated: false, renamed: false };
		}

		const rawBudget = frontmatter.budget;
		const budget = rawBudget === null || rawBudget === undefined || rawBudget === ''
			? null
			: Number(rawBudget);
		const report = this.expenseService.buildPeriodReportFromTransactions(
			allTransactions,
			periodDescriptor,
			Number.isFinite(budget) ? budget : null,
		);

		const updatedFile = await this.expenseService.upsertReportFile(report, { existingFile: file });
		const updatedContent = await this.app.vault.cachedRead(updatedFile);
		return {
			updated: currentContent !== updatedContent,
			renamed: oldPath !== updatedFile.path,
		};
	}

	private inferReportDescriptor(frontmatter: Record<string, unknown>): ReportPeriodDescriptor | null {
		const explicitKind = typeof frontmatter.periodKind === 'string'
			? frontmatter.periodKind as ReportPeriodKind
			: null;
		const startValue = this.readPeriodBoundary(frontmatter, 'periodStart', 0);
		const endValue = this.readPeriodBoundary(frontmatter, 'periodEnd', 1);
		if (!startValue || !endValue) {
			return null;
		}

		const startDate = new Date(`${startValue}T00:00:00`);
		const endDate = new Date(`${endValue}T00:00:00`);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			return null;
		}

		if (explicitKind === 'month' || explicitKind === 'quarter' || explicitKind === 'half-year' || explicitKind === 'year') {
			return getPeriodDescriptorForDate(explicitKind, startDate);
		}

		for (const kind of ['month', 'quarter', 'half-year', 'year'] as const) {
			const descriptor = getPeriodDescriptorForDate(kind, startDate);
			if (
				formatDateKey(descriptor.startDate) === formatDateKey(startDate)
				&& formatDateKey(descriptor.endDate) === formatDateKey(endDate)
			) {
				return descriptor;
			}
		}

		return createCustomPeriodDescriptor(startDate, endDate);
	}

	private readPeriodBoundary(
		frontmatter: Record<string, unknown>,
		key: 'periodStart' | 'periodEnd',
		index: 0 | 1,
	): string | null {
		const directValue = frontmatter[key];
		if (typeof directValue === 'string' && directValue.trim()) {
			return directValue.trim();
		}

		const legacyPeriod = frontmatter.period;
		if (typeof legacyPeriod !== 'string') {
			return null;
		}

		const parts = legacyPeriod.split(' to ').map((part) => part.trim());
		return parts[index] || null;
	}
}
