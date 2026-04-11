import { App, Modal, Notice, TFile } from 'obsidian';
import type { TransactionData } from '../types';
import {
	DuplicateMergeFieldState,
	DuplicateMergeSectionState,
	DuplicateMergeSession,
	DuplicateMergeWorkflowService,
} from '../services/duplicate-merge-workflow-service';

export class DuplicateMergeModal extends Modal {
	private duplicates: TransactionData[] = [];
	private selectedDuplicatePath: string | null;
	private session: DuplicateMergeSession | null = null;
	private loading = false;
	private merging = false;
	private errorMessage: string | null = null;
	private actionMessage: { kind: 'error' | 'success'; text: string } | null = null;
	private showResolvedFields = false;
	private resizeObserver: ResizeObserver | null = null;

	onMerged: ((file: TFile) => void | Promise<void>) | null = null;

	constructor(
		app: App,
		private readonly workflowService: DuplicateMergeWorkflowService,
		initialDuplicatePath?: string | null,
	) {
		super(app);
		this.selectedDuplicatePath = initialDuplicatePath ?? null;
	}

	onOpen() {
		this.modalEl.addClass('expense-manager-duplicate-merge-modal');
		this.setupResponsiveLayoutObserver();
		void this.reload();
	}

	onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentEl.empty();
	}

	private setupResponsiveLayoutObserver(): void {
		const updateLayoutClasses = (width: number) => {
			this.modalEl.classList.toggle('is-tight', width < 1360);
			this.modalEl.classList.toggle('is-compact', width < 1180);
			this.modalEl.classList.toggle('is-narrow', width < 920);
		};

		updateLayoutClasses(this.modalEl.clientWidth || window.innerWidth);
		if (typeof ResizeObserver === 'undefined') {
			return;
		}

		this.resizeObserver?.disconnect();
		this.resizeObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? this.modalEl.clientWidth ?? window.innerWidth;
			updateLayoutClasses(width);
		});
		this.resizeObserver.observe(this.modalEl);
	}

	private async reload(preferredDuplicatePath?: string | null): Promise<void> {
		this.loading = true;
		this.errorMessage = null;
		this.actionMessage = null;
		this.render();
		try {
			this.duplicates = await this.workflowService.listDuplicateCandidates();
			const nextSelectedPath = preferredDuplicatePath
				?? this.selectedDuplicatePath
				?? this.duplicates[0]?.file?.path
				?? null;
			this.selectedDuplicatePath = nextSelectedPath && this.duplicates.some((item) => item.file?.path === nextSelectedPath)
				? nextSelectedPath
				: this.duplicates[0]?.file?.path ?? null;
			if (this.selectedDuplicatePath) {
				await this.loadSession(this.selectedDuplicatePath);
			} else {
				this.session = null;
			}
		} catch (error) {
			this.errorMessage = (error as Error).message;
			this.session = null;
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async loadSession(duplicatePath: string): Promise<void> {
		const duplicateFile = this.app.vault.getAbstractFileByPath(duplicatePath);
		if (!(duplicateFile instanceof TFile)) {
			throw new Error('Duplicate note was not found.');
		}
		this.session = await this.workflowService.buildSession(duplicateFile);
		this.selectedDuplicatePath = duplicatePath;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Merge duplicate finance notes' });
		contentEl.createEl('p', {
			text: 'Pick a duplicate on the left, resolve conflicts in the center, and merge it back into the original note.',
		});

		if (this.loading) {
			contentEl.createDiv({ cls: 'expense-manager-duplicate-merge-empty', text: 'Loading duplicate merge queue...' });
			return;
		}

		if (this.errorMessage) {
			contentEl.createDiv({ cls: 'expense-manager-duplicate-merge-empty', text: `Could not load duplicate merge queue: ${this.errorMessage}` });
			return;
		}

		const layoutEl = contentEl.createDiv({ cls: 'expense-manager-duplicate-merge-layout' });
		this.renderSidebar(layoutEl.createDiv({ cls: 'expense-manager-duplicate-merge-sidebar' }));
		this.renderMain(layoutEl.createDiv({ cls: 'expense-manager-duplicate-merge-main' }));
	}

	private renderSidebar(containerEl: HTMLElement): void {
		containerEl.empty();
		containerEl.createEl('h3', { text: `Duplicates (${this.duplicates.length})` });
		if (this.duplicates.length === 0) {
			containerEl.createDiv({
				cls: 'expense-manager-duplicate-merge-empty',
				text: 'There are no duplicate notes waiting for merge right now.',
			});
			return;
		}

		const listEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-list' });
		for (const duplicate of this.duplicates) {
			const filePath = duplicate.file?.path;
			if (!filePath) {
				continue;
			}

			const itemEl = listEl.createDiv({
				cls: [
					'expense-manager-duplicate-merge-list-item',
					this.selectedDuplicatePath === filePath ? 'is-active' : '',
				].filter(Boolean).join(' '),
			});
			itemEl.createEl('div', {
				cls: 'expense-manager-duplicate-merge-list-title',
				text: duplicate.description || duplicate.file?.basename || filePath,
			});
			itemEl.createEl('div', {
				cls: 'expense-manager-duplicate-merge-list-meta',
				text: `${duplicate.amount.toFixed(2)} ${duplicate.currency} • ${this.formatDateTimeLabel(duplicate.dateTime)}`,
			});
			itemEl.createEl('div', {
				cls: 'expense-manager-duplicate-merge-list-meta',
				text: duplicate.duplicateOf ? `Original: ${duplicate.duplicateOf}` : 'Original link missing',
			});
			itemEl.addEventListener('click', () => {
				void this.selectDuplicate(filePath);
			});
		}
	}

	private renderMain(containerEl: HTMLElement): void {
		containerEl.empty();
		if (!this.session) {
			containerEl.createDiv({
				cls: 'expense-manager-duplicate-merge-empty',
				text: 'Select a duplicate note to start reviewing differences.',
			});
			return;
		}

		const unresolvedFieldCount = this.session.fields.filter((field) => field.state === 'conflict' && field.choice === null).length;
		const unresolvedSectionCount = this.session.sections.filter((section) => section.state === 'conflict' && section.choice === null).length;
		const summaryEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-summary' });
		summaryEl.createEl('div', {
			text: `Original: ${this.session.originalFile.path}`,
		});
		summaryEl.createEl('div', {
			text: `Duplicate: ${this.session.duplicateFile.path}`,
		});
		summaryEl.createEl('div', {
			text: `Unresolved: ${unresolvedFieldCount} field(s), ${unresolvedSectionCount} section(s)`,
		});

		if (this.actionMessage) {
			containerEl.createDiv({
				cls: `expense-manager-duplicate-merge-feedback is-${this.actionMessage.kind}`,
				text: this.actionMessage.text,
			});
		}

		const toggleRow = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-toggle-row' });
		const toggleLabel = toggleRow.createEl('label', { cls: 'expense-manager-duplicate-merge-toggle-label' });
		const checkbox = toggleLabel.createEl('input', { attr: { type: 'checkbox' } });
		checkbox.checked = this.showResolvedFields;
		checkbox.addEventListener('change', () => {
			this.showResolvedFields = checkbox.checked;
			this.render();
		});
		toggleLabel.createSpan({ text: 'Show identical auto-resolved fields and sections' });

		this.renderFieldGrid(containerEl, this.session.fields);
		this.renderSectionGrid(containerEl, this.session.sections);

		const actionsEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-actions' });
		const mergeButton = actionsEl.createEl('button', {
			text: this.merging ? 'Merging...' : 'Merge',
			cls: 'mod-cta',
			attr: { type: 'button' },
		});
		mergeButton.disabled = this.merging;
		mergeButton.addEventListener('click', () => {
			void this.mergeCurrentSession();
		});

		const refreshButton = actionsEl.createEl('button', {
			text: 'Refresh queue',
			attr: { type: 'button' },
		});
		refreshButton.disabled = this.merging;
		refreshButton.addEventListener('click', () => {
			void this.reload(this.selectedDuplicatePath);
		});
	}

	private renderFieldGrid(containerEl: HTMLElement, fields: DuplicateMergeFieldState[]): void {
		const visibleFields = fields.filter((field) => this.showResolvedFields || field.state !== 'equal');
		const sectionEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-section' });
		sectionEl.createEl('h3', { text: 'Fields' });
		if (visibleFields.length === 0) {
			sectionEl.createDiv({
				cls: 'expense-manager-duplicate-merge-empty',
				text: 'All fields match and are already resolved automatically.',
			});
			return;
		}

		this.renderCompareHeader(sectionEl);
		for (const field of visibleFields) {
			const rowEl = sectionEl.createDiv({
				cls: `expense-manager-duplicate-merge-row state-${field.state}`,
			});
			const labelEl = rowEl.createDiv({ cls: 'expense-manager-duplicate-merge-row-label' });
			labelEl.createEl('strong', { text: field.label });
			labelEl.createDiv({
				cls: 'expense-manager-duplicate-merge-row-status',
				text: this.describeState(field.state, field.choice),
			});

			this.renderValueCell(rowEl, field.originalValue || '—');
			this.renderFieldEditor(rowEl, field);
			this.renderValueCell(rowEl, field.duplicateValue || '—');
		}
	}

	private renderSectionGrid(containerEl: HTMLElement, sections: DuplicateMergeSectionState[]): void {
		const visibleSections = sections.filter((section) => this.showResolvedFields || section.state !== 'equal');
		const sectionEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-section' });
		sectionEl.createEl('h3', { text: 'Body sections' });
		if (visibleSections.length === 0) {
			sectionEl.createDiv({
				cls: 'expense-manager-duplicate-merge-empty',
				text: 'All structured body sections match and are already resolved automatically.',
			});
			return;
		}

		this.renderCompareHeader(sectionEl);
		for (const section of visibleSections) {
			const rowEl = sectionEl.createDiv({
				cls: `expense-manager-duplicate-merge-row state-${section.state}`,
			});
			const labelEl = rowEl.createDiv({ cls: 'expense-manager-duplicate-merge-row-label' });
			labelEl.createEl('strong', { text: section.label });
			labelEl.createDiv({
				cls: 'expense-manager-duplicate-merge-row-status',
				text: this.describeState(section.state, section.choice),
			});

			this.renderValueCell(rowEl, section.originalValue || '—', true);
			this.renderSectionEditor(rowEl, section);
			this.renderValueCell(rowEl, section.duplicateValue || '—', true);
		}
	}

	private renderCompareHeader(containerEl: HTMLElement): void {
		const headerEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-header' });
		headerEl.createDiv({ text: '' });
		headerEl.createDiv({ text: 'Original' });
		headerEl.createDiv({ text: 'Merged' });
		headerEl.createDiv({ text: 'Duplicate' });
	}

	private renderValueCell(containerEl: HTMLElement, value: string, multiline = false): void {
		const cellEl = containerEl.createDiv({
			cls: `expense-manager-duplicate-merge-cell${multiline ? ' is-multiline' : ''}`,
		});
		cellEl.setText(value);
	}

	private renderFieldEditor(containerEl: HTMLElement, field: DuplicateMergeFieldState): void {
		const cellEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-cell expense-manager-duplicate-merge-editor' });
		this.renderChoiceButtons(cellEl, field, () => this.render());

		if (field.inputType === 'textarea') {
			const textarea = cellEl.createEl('textarea', { cls: 'expense-manager-duplicate-merge-textarea' });
			textarea.value = field.mergedValue;
			textarea.rows = 3;
			textarea.addEventListener('input', () => {
				field.mergedValue = textarea.value;
				field.choice = 'custom';
				this.actionMessage = null;
			});
			return;
		}

		const input = cellEl.createEl('input', { cls: 'expense-manager-duplicate-merge-input' });
		input.value = field.inputType === 'datetime'
			? this.toLocalDateTimeInputValue(field.mergedValue)
			: field.mergedValue;
		input.type = field.inputType === 'number'
			? 'number'
			: field.inputType === 'datetime'
				? 'datetime-local'
				: 'text';
		if (field.inputType === 'number') {
			input.step = '0.01';
		}
		if (field.inputType === 'datetime') {
			input.step = '60';
		}
		input.addEventListener('input', () => {
			field.mergedValue = field.inputType === 'datetime'
				? this.fromLocalDateTimeInputValue(input.value, field.mergedValue)
				: input.value;
			field.choice = 'custom';
			this.actionMessage = null;
		});
	}

	private renderSectionEditor(containerEl: HTMLElement, section: DuplicateMergeSectionState): void {
		const cellEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-cell expense-manager-duplicate-merge-editor is-multiline' });
		this.renderChoiceButtons(cellEl, section, () => this.render());
		const textarea = cellEl.createEl('textarea', { cls: 'expense-manager-duplicate-merge-textarea' });
		textarea.value = section.mergedValue;
		textarea.rows = 8;
		textarea.addEventListener('input', () => {
			section.mergedValue = textarea.value;
			section.choice = 'custom';
			this.actionMessage = null;
		});
	}

	private renderChoiceButtons(
		containerEl: HTMLElement,
		target: DuplicateMergeFieldState | DuplicateMergeSectionState,
		onChange: () => void,
	): void {
		const buttonsEl = containerEl.createDiv({ cls: 'expense-manager-duplicate-merge-choice-row' });
		this.createChoiceButton(buttonsEl, 'Use original', target.choice === 'original', () => {
			target.choice = 'original';
			target.mergedValue = target.originalValue;
			this.actionMessage = null;
			onChange();
		});
		this.createChoiceButton(buttonsEl, 'Use duplicate', target.choice === 'duplicate', () => {
			target.choice = 'duplicate';
			target.mergedValue = target.duplicateValue;
			this.actionMessage = null;
			onChange();
		});
		this.createChoiceButton(buttonsEl, 'Clear', target.choice === 'clear', () => {
			target.choice = 'clear';
			target.mergedValue = '';
			this.actionMessage = null;
			onChange();
		});
	}

	private createChoiceButton(
		containerEl: HTMLElement,
		label: string,
		active: boolean,
		onClick: () => void,
	): void {
		const button = containerEl.createEl('button', {
			text: label,
			cls: active ? 'is-active' : '',
			attr: { type: 'button' },
		});
		button.addEventListener('click', (event) => {
			event.preventDefault();
			onClick();
		});
	}

	private async selectDuplicate(path: string): Promise<void> {
		this.loading = true;
		this.errorMessage = null;
		this.actionMessage = null;
		this.render();
		try {
			await this.loadSession(path);
		} catch (error) {
			this.errorMessage = (error as Error).message;
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async mergeCurrentSession(): Promise<void> {
		if (!this.session || this.merging) {
			return;
		}

		this.merging = true;
		this.actionMessage = null;
		this.render();
		try {
			const mergedFile = await this.workflowService.applySession(this.session);
			this.actionMessage = {
				kind: 'success',
				text: `Duplicate merged into ${mergedFile.path}`,
			};
			new Notice(`Duplicate merged into ${mergedFile.path}`, 5000);
			await this.onMerged?.(mergedFile);
			await this.reload(mergedFile.path);
		} catch (error) {
			const message = `Could not merge duplicate: ${(error as Error).message}`;
			this.actionMessage = {
				kind: 'error',
				text: message,
			};
			new Notice(message);
			this.render();
		} finally {
			this.merging = false;
			if (this.session) {
				this.render();
			}
		}
	}

	private describeState(
		state: DuplicateMergeFieldState['state'],
		choice: DuplicateMergeFieldState['choice'],
	): string {
		if (state === 'equal') {
			return 'Same on both sides';
		}
		if (state === 'left-only') {
			return choice === 'auto' ? 'Filled from original' : 'Only original has a value';
		}
		if (state === 'right-only') {
			return choice === 'auto' ? 'Filled from duplicate' : 'Only duplicate has a value';
		}
		if (choice === null) {
			return 'Needs a manual decision';
		}
		if (choice === 'clear') {
			return 'Will be cleared';
		}
		return 'Resolved';
	}

	private formatDateTimeLabel(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}
		return date.toISOString().replace('T', ' ').slice(0, 16);
	}

	private toLocalDateTimeInputValue(value: string): string {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) {
			return '';
		}
		const year = parsed.getFullYear();
		const month = String(parsed.getMonth() + 1).padStart(2, '0');
		const day = String(parsed.getDate()).padStart(2, '0');
		const hours = String(parsed.getHours()).padStart(2, '0');
		const minutes = String(parsed.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day}T${hours}:${minutes}`;
	}

	private fromLocalDateTimeInputValue(value: string, fallbackIso: string): string {
		const trimmed = value.trim();
		if (!trimmed) {
			return fallbackIso;
		}
		const parsed = new Date(trimmed);
		if (Number.isNaN(parsed.getTime())) {
			return fallbackIso;
		}
		return parsed.toISOString();
	}
}
