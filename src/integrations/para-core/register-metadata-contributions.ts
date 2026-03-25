import { App, TFile } from 'obsidian';
import {
	IParaCoreApi,
	TelegramInlineKeyboard,
} from './types';

interface RegisterFinanceMetadataContributionOptions {
	buildProjectBudgetKeyboard?: (
		path: string,
		page: number,
	) => TelegramInlineKeyboard | Promise<TelegramInlineKeyboard | null | undefined> | null | undefined;
}

export function registerFinanceMetadataContributions(
	api: IParaCoreApi,
	app: App,
	options: RegisterFinanceMetadataContributionOptions = {},
): void {
	api.registerMetadataContribution({
		id: 'finance.project-budget',
		domainId: 'finance',
		target: 'project',
		order: 100,
		frontmatterDefaults: {
			finance_budget: null,
		},
		renderMetadataLines: ({ path }) => {
			if (!path) {
				return null;
			}

			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				return null;
			}

			const budget = readBudget(app, file);
			return [`Finance budget: ${budget === null ? '-' : `${budget.toFixed(2)} RUB`}`];
		},
		buildInlineKeyboard: async ({ path, page }) => {
			if (!path || typeof page !== 'number' || !options.buildProjectBudgetKeyboard) {
				return null;
			}

			return options.buildProjectBudgetKeyboard(path, page);
		},
	});
}

function readBudget(app: App, file: TFile): number | null {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter) {
		return null;
	}

	if (Object.prototype.hasOwnProperty.call(frontmatter, 'finance_budget')) {
		const rawValue = frontmatter.finance_budget;
		if (rawValue === null || rawValue === undefined || rawValue === '') {
			return null;
		}

		const budget = Number(rawValue);
		return Number.isFinite(budget) ? budget : null;
	}

	const legacyBudget = Number(frontmatter.budget);
	return Number.isFinite(legacyBudget) ? legacyBudget : null;
}
