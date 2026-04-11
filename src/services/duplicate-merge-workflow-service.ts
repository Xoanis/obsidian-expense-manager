import { App, TFile } from 'obsidian';
import type { TransactionData } from '../types';
import { ExpenseService } from './expense-service';
import {
	generateYamlFrontmatterRecord,
	type MarkdownSection,
	parseMarkdownSections,
	renderMarkdownSections,
} from '../utils/frontmatter';

export type DuplicateMergeComparisonState = 'equal' | 'left-only' | 'right-only' | 'conflict';
export type DuplicateMergeChoice = 'auto' | 'original' | 'duplicate' | 'custom' | 'clear' | null;
export type DuplicateMergeFieldInputType = 'datetime' | 'number' | 'text' | 'textarea' | 'tags' | 'wikilink';

export interface DuplicateMergeFieldState {
	key: string;
	label: string;
	inputType: DuplicateMergeFieldInputType;
	required: boolean;
	state: DuplicateMergeComparisonState;
	choice: DuplicateMergeChoice;
	originalValue: string;
	duplicateValue: string;
	mergedValue: string;
}

export interface DuplicateMergeSectionState {
	key: string;
	label: string;
	state: DuplicateMergeComparisonState;
	choice: DuplicateMergeChoice;
	originalValue: string;
	duplicateValue: string;
	mergedValue: string;
}

export interface DuplicateMergeSession {
	originalFile: TFile;
	duplicateFile: TFile;
	original: TransactionData;
	duplicate: TransactionData;
	fields: DuplicateMergeFieldState[];
	sections: DuplicateMergeSectionState[];
}

interface DuplicateMergeFieldDefinition {
	key: string;
	label: string;
	inputType: DuplicateMergeFieldInputType;
	required: boolean;
	read(transaction: TransactionData): string;
	write(target: MergedDuplicateTransactionDraft, value: string): void;
	isEqual?(left: string, right: string): boolean;
}

interface MergedDuplicateTransactionDraft {
	dateTime: string;
	amount: number;
	currency: string;
	description: string;
	category: string;
	tags: string[];
	area?: string;
	project?: string;
	fn?: string;
	fd?: string;
	fp?: string;
}

const FIELD_DEFINITIONS: DuplicateMergeFieldDefinition[] = [
	{
		key: 'dateTime',
		label: 'Date and time',
		inputType: 'datetime',
		required: true,
		read: (transaction) => transaction.dateTime ?? '',
		write: (target, value) => {
			target.dateTime = value.trim();
		},
	},
	{
		key: 'amount',
		label: 'Amount',
		inputType: 'number',
		required: true,
		read: (transaction) => Number.isFinite(transaction.amount) ? String(transaction.amount) : '',
		write: (target, value) => {
			target.amount = Number(value);
		},
		isEqual: (left, right) => Math.abs(Number(left) - Number(right)) <= 0.0001,
	},
	{
		key: 'currency',
		label: 'Currency',
		inputType: 'text',
		required: true,
		read: (transaction) => transaction.currency ?? '',
		write: (target, value) => {
			target.currency = value.trim().toUpperCase();
		},
	},
	{
		key: 'description',
		label: 'Description',
		inputType: 'textarea',
		required: true,
		read: (transaction) => transaction.description ?? '',
		write: (target, value) => {
			target.description = value.trim();
		},
	},
	{
		key: 'category',
		label: 'Category',
		inputType: 'text',
		required: false,
		read: (transaction) => transaction.category ?? '',
		write: (target, value) => {
			target.category = value.trim();
		},
	},
	{
		key: 'tags',
		label: 'Tags',
		inputType: 'tags',
		required: false,
		read: (transaction) => (transaction.tags ?? []).join(', '),
		write: (target, value) => {
			target.tags = parseTags(value);
		},
		isEqual: (left, right) => normalizeTagSet(left) === normalizeTagSet(right),
	},
	{
		key: 'area',
		label: 'Area',
		inputType: 'wikilink',
		required: false,
		read: (transaction) => transaction.area ?? '',
		write: (target, value) => {
			target.area = normalizeWikiLink(value);
		},
	},
	{
		key: 'project',
		label: 'Project',
		inputType: 'wikilink',
		required: false,
		read: (transaction) => transaction.project ?? '',
		write: (target, value) => {
			target.project = normalizeWikiLink(value);
		},
	},
	{
		key: 'fn',
		label: 'Fiscal drive number (FN)',
		inputType: 'text',
		required: false,
		read: (transaction) => transaction.fn ?? '',
		write: (target, value) => {
			target.fn = normalizeOptionalText(value);
		},
	},
	{
		key: 'fd',
		label: 'Fiscal document number (FD)',
		inputType: 'text',
		required: false,
		read: (transaction) => transaction.fd ?? '',
		write: (target, value) => {
			target.fd = normalizeOptionalText(value);
		},
	},
	{
		key: 'fp',
		label: 'Fiscal sign (FP)',
		inputType: 'text',
		required: false,
		read: (transaction) => transaction.fp ?? '',
		write: (target, value) => {
			target.fp = normalizeOptionalText(value);
		},
	},
];

export class DuplicateMergeWorkflowService {
	constructor(
		private readonly app: App,
		private readonly expenseService: ExpenseService,
	) {}

	async listDuplicateCandidates(): Promise<TransactionData[]> {
		return this.expenseService.getDuplicateTransactions();
	}

	async buildSession(duplicateFile: TFile): Promise<DuplicateMergeSession> {
		const duplicate = await this.expenseService.parseTransactionFile(duplicateFile);
		if (!duplicate || duplicate.status !== 'duplicate') {
			throw new Error('The selected note is not a duplicate finance note.');
		}

		const originalFile = this.resolveOriginalFile(duplicate);
		if (!(originalFile instanceof TFile)) {
			throw new Error('The duplicate note does not point to a valid original transaction.');
		}

		const original = await this.expenseService.parseTransactionFile(originalFile);
		if (!original) {
			throw new Error('Could not parse the original finance note.');
		}

		const originalContent = await this.app.vault.cachedRead(originalFile);
		const duplicateContent = await this.app.vault.cachedRead(duplicateFile);
		return {
			originalFile,
			duplicateFile,
			original,
			duplicate,
			fields: FIELD_DEFINITIONS.map((definition) => this.buildFieldState(definition, original, duplicate)),
			sections: this.buildSectionStates(
				parseMarkdownSections(originalContent),
				parseMarkdownSections(duplicateContent),
			),
		};
	}

	async applySession(session: DuplicateMergeSession): Promise<TFile> {
		this.assertSessionResolved(session);
		const mergedDraft = this.buildMergedDraft(session.fields);
		const mergedSections = session.sections
			.filter((section) => section.choice !== null)
			.map((section) => ({
				title: section.label === 'Body' ? '' : section.label,
				content: section.choice === 'clear' ? '' : section.mergedValue.trim(),
			}))
			.filter((section) => section.content.length > 0);
		const artifactSection = mergedSections.find((section) => normalizeSectionKey(section.title) === 'artifact');
		const sourceContextSection = mergedSections.find((section) => normalizeSectionKey(section.title) === 'source context');

		const category = mergedDraft.category || session.original.category || session.duplicate.category || 'uncategorized';
		const tags = mergedDraft.tags.length > 0 ? mergedDraft.tags : [];
		if (!tags.some((tag) => tag.toLowerCase() === category.toLowerCase())) {
			tags.push(category.toLowerCase());
		}

		const mergedTransaction: TransactionData = {
			type: session.original.type,
			status: 'recorded',
			amount: mergedDraft.amount,
			currency: mergedDraft.currency,
			dateTime: mergedDraft.dateTime,
			description: mergedDraft.description,
			category,
			tags,
			area: mergedDraft.area,
			project: mergedDraft.project,
			artifact: normalizeOptionalText(artifactSection?.content),
			sourceContext: normalizeOptionalText(sourceContextSection?.content),
			source: this.resolveMergedSource(session.original, session.duplicate),
			emailMessageId: session.original.emailMessageId ?? session.duplicate.emailMessageId,
			emailProvider: session.original.emailProvider ?? session.duplicate.emailProvider,
			emailMailboxScope: session.original.emailMailboxScope ?? session.duplicate.emailMailboxScope,
			duplicateOf: undefined,
			fn: mergedDraft.fn,
			fd: mergedDraft.fd,
			fp: mergedDraft.fp,
			receiptOperationType: session.original.receiptOperationType ?? session.duplicate.receiptOperationType,
			proverkaCheka: session.original.proverkaCheka === true || session.duplicate.proverkaCheka === true ? true : undefined,
		};

		const fullContent = generateYamlFrontmatterRecord({
			type: mergedTransaction.type,
			status: 'recorded',
			amount: mergedTransaction.amount,
			currency: mergedTransaction.currency,
			dateTime: mergedTransaction.dateTime,
			description: mergedTransaction.description,
			area: mergedTransaction.area,
			project: mergedTransaction.project,
			tags: mergedTransaction.tags,
			category: mergedTransaction.category,
			source: mergedTransaction.source,
			artifact: mergedTransaction.artifact,
			email_msg_id: mergedTransaction.emailMessageId,
			email_provider: mergedTransaction.emailProvider,
			email_mailbox_scope: mergedTransaction.emailMailboxScope,
			fn: mergedTransaction.fn,
			fd: mergedTransaction.fd,
			fp: mergedTransaction.fp,
			receiptOperationType: mergedTransaction.receiptOperationType,
			ProverkaCheka: mergedTransaction.proverkaCheka === true ? true : undefined,
		}) + renderMarkdownSections(mergedSections);

		const updatedOriginalFile = await this.expenseService.replaceTransactionContentWithFileSync(
			session.originalFile,
			fullContent,
			mergedTransaction,
		);
		await this.expenseService.deleteTransaction(session.duplicateFile);
		return updatedOriginalFile;
	}

	private buildFieldState(
		definition: DuplicateMergeFieldDefinition,
		original: TransactionData,
		duplicate: TransactionData,
	): DuplicateMergeFieldState {
		const originalValue = definition.read(original);
		const duplicateValue = definition.read(duplicate);
		const state = this.resolveComparisonState(
			originalValue,
			duplicateValue,
			definition.isEqual,
		);
		return {
			key: definition.key,
			label: definition.label,
			inputType: definition.inputType,
			required: definition.required,
			state,
			choice: state === 'conflict' ? null : 'auto',
			originalValue,
			duplicateValue,
			mergedValue: state === 'conflict'
				? ''
				: this.pickAutoValue(originalValue, duplicateValue),
		};
	}

	private buildSectionStates(
		originalSections: MarkdownSection[],
		duplicateSections: MarkdownSection[],
	): DuplicateMergeSectionState[] {
		const originalMap = new Map(originalSections.map((section) => [normalizeSectionKey(section.title), section]));
		const duplicateMap = new Map(duplicateSections.map((section) => [normalizeSectionKey(section.title), section]));
		const orderedKeys = [
			...new Set([
				...originalSections.map((section) => normalizeSectionKey(section.title)),
				...duplicateSections.map((section) => normalizeSectionKey(section.title)),
			]),
		];

		return orderedKeys.map((key) => {
			const originalSection = originalMap.get(key);
			const duplicateSection = duplicateMap.get(key);
			const originalValue = originalSection?.content ?? '';
			const duplicateValue = duplicateSection?.content ?? '';
			const state = this.resolveComparisonState(originalValue, duplicateValue);
			return {
				key,
				label: originalSection?.title || duplicateSection?.title || 'Body',
				state,
				choice: state === 'conflict' ? null : 'auto',
				originalValue,
				duplicateValue,
				mergedValue: state === 'conflict' ? '' : this.pickAutoValue(originalValue, duplicateValue),
			};
		});
	}

	private buildMergedDraft(fields: DuplicateMergeFieldState[]): MergedDuplicateTransactionDraft {
		const draft: MergedDuplicateTransactionDraft = {
			dateTime: '',
			amount: Number.NaN,
			currency: '',
			description: '',
			category: '',
			tags: [],
		};

		for (const definition of FIELD_DEFINITIONS) {
			const field = fields.find((candidate) => candidate.key === definition.key);
			if (!field) {
				continue;
			}
			definition.write(draft, field.choice === 'clear' ? '' : field.mergedValue);
		}

		return draft;
	}

	private assertSessionResolved(session: DuplicateMergeSession): void {
		const unresolvedField = session.fields.find((field) => field.state === 'conflict' && field.choice === null);
		if (unresolvedField) {
			throw new Error(`Resolve the field "${unresolvedField.label}" before merging.`);
		}

		const unresolvedSection = session.sections.find((section) => section.state === 'conflict' && section.choice === null);
		if (unresolvedSection) {
			throw new Error(`Resolve the section "${unresolvedSection.label}" before merging.`);
		}

		for (const field of session.fields) {
			if (!field.required) {
				continue;
			}
			const value = field.choice === 'clear' ? '' : field.mergedValue.trim();
			if (!value) {
				throw new Error(`The field "${field.label}" is required.`);
			}
			if (field.key === 'amount' && !Number.isFinite(Number(value))) {
				throw new Error('Amount must be a valid number.');
			}
			if (field.key === 'dateTime' && Number.isNaN(new Date(value).getTime())) {
				throw new Error('Date and time must be valid.');
			}
		}
	}

	private resolveOriginalFile(duplicate: TransactionData): TFile | null {
		const linkPath = extractLinkPath(duplicate.duplicateOf);
		if (!linkPath) {
			return null;
		}
		return this.app.metadataCache.getFirstLinkpathDest(linkPath, '') ?? null;
	}

	private resolveMergedSource(original: TransactionData, duplicate: TransactionData): TransactionData['source'] {
		if (original.source === duplicate.source) {
			return original.source;
		}
		if (original.source !== 'manual') {
			return original.source;
		}
		if (duplicate.source !== 'manual') {
			return duplicate.source;
		}
		return original.source;
	}

	private resolveComparisonState(
		originalValue: string,
		duplicateValue: string,
		isEqual?: (left: string, right: string) => boolean,
	): DuplicateMergeComparisonState {
		const left = originalValue.trim();
		const right = duplicateValue.trim();
		if ((isEqual?.(left, right) ?? left === right)) {
			return 'equal';
		}
		if (left && !right) {
			return 'left-only';
		}
		if (!left && right) {
			return 'right-only';
		}
		return 'conflict';
	}

	private pickAutoValue(originalValue: string, duplicateValue: string): string {
		return originalValue.trim() || duplicateValue.trim();
	}
}

function extractLinkPath(value: string | undefined): string | null {
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

function normalizeWikiLink(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	if (/^\[\[.*\]\]$/.test(trimmed)) {
		return trimmed;
	}
	return `[[${trimmed}]]`;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseTags(value: string): string[] {
	return Array.from(new Set(
		value
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0),
	));
}

function normalizeTagSet(value: string): string {
	return parseTags(value)
		.map((tag) => tag.toLowerCase())
		.sort((left, right) => left.localeCompare(right))
		.join('|');
}

function normalizeSectionKey(value: string): string {
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : '__body__';
}
