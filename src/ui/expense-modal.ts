import { App, Modal, Setting, TFile, TextComponent } from 'obsidian';
import { TransactionData, TransactionSaveMode, TransactionType } from '../types';

interface LinkedNoteSuggestion {
	name: string;
	path: string;
}

export class ExpenseModal extends Modal {
	private amount: number = 0;
	private type: TransactionType = 'expense';
	private currency: string = 'RUB';
	private description: string = '';
	private category: string = '';
	private tagsInput: string = '';
	private dateTime: string = new Date().toISOString();
	private area: string = '';
	private project: string = '';
	
	private categories: string[] = [];
	private areaSuggestions: LinkedNoteSuggestion[] = [];
	private projectSuggestions: LinkedNoteSuggestion[] = [];
	
	onComplete: ((data: TransactionData, saveMode?: TransactionSaveMode) => void) | null = null;
	onCancel: (() => void) | null = null;

	constructor(
		app: App,
		defaultType: TransactionType = 'expense',
		defaultCurrency: string = 'RUB',
		categories: string[] = [],
		initialData?: Partial<TransactionData>,
	) {
		super(app);
		this.type = defaultType;
		this.currency = defaultCurrency;
		this.categories = categories;
		if (categories.length > 0) {
			this.category = categories[0];
		}
		this.applyInitialData(initialData);
		this.areaSuggestions = this.getTypedNoteSuggestions('area');
		this.projectSuggestions = this.getTypedNoteSuggestions('project');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Review finance record' });
		contentEl.createEl('p', { text: 'Check the extracted details before saving the record.' });

		// Type selector
		new Setting(contentEl)
			.setName('Type')
			.addDropdown(dropdown => {
				dropdown
					.addOption('expense', 'Expense')
					.addOption('income', 'Income')
					.setValue(this.type)
					.onChange(value => {
						this.type = value as TransactionType;
					});
			});

		// Amount input
		new Setting(contentEl)
			.setName('Amount')
			.addText(text => {
				text
					.setPlaceholder('0.00')
					.setValue(this.amount.toString())
					.onChange(value => {
						this.amount = parseFloat(value) || 0;
					});
				text.inputEl.type = 'number';
				text.inputEl.step = '0.01';
				text.inputEl.min = '0';
			});

		// Currency
		new Setting(contentEl)
			.setName('Currency')
			.addText(text => {
				text
					.setPlaceholder('RUB')
					.setValue(this.currency)
					.onChange(value => {
						this.currency = value.toUpperCase();
					});
			});

		new Setting(contentEl)
			.setName('Date and time')
			.setDesc('Choose when the transaction happened. This value controls note naming and dated folder placement.')
			.addText(text => {
				text
					.setPlaceholder('2026-04-11T14:30')
					.setValue(this.toLocalDateTimeInputValue(this.dateTime))
					.onChange(value => {
						this.dateTime = this.fromLocalDateTimeInputValue(value, this.dateTime);
					});
				text.inputEl.type = 'datetime-local';
				text.inputEl.step = '60';
			});

		// Category selector
		if (this.categories.length > 0) {
			new Setting(contentEl)
				.setName('Category')
				.addDropdown(dropdown => {
					for (const cat of this.categories) {
						dropdown.addOption(cat, cat);
					}
					dropdown
						.setValue(this.category)
						.onChange(value => {
							this.category = value;
						});
				});
		}

		// Tags input
		new Setting(contentEl)
			.setName('Tags')
			.setDesc('Comma-separated tags for categorization')
			.addText(text => {
				text
					.setPlaceholder('food, groceries, lunch')
					.setValue(this.tagsInput)
					.onChange(value => {
						this.tagsInput = value;
					});
			});

		this.addLinkedNoteSetting(
			contentEl,
			'Area',
			'Optional PARA area. You can use Home or [[Home]].',
			'[[Health]]',
			this.area,
			this.areaSuggestions,
			'area',
			(value) => {
				this.area = value;
			},
		);

		this.addLinkedNoteSetting(
			contentEl,
			'Project',
			'Optional PARA project. You can use Project Name or [[Project Name]].',
			'[[My Project]]',
			this.project,
			this.projectSuggestions,
			'project',
			(value) => {
				this.project = value;
			},
		);

		// Description
		new Setting(contentEl)
			.setName('Description')
			.addTextArea(text => {
				text
					.setPlaceholder('Short description')
					.setValue(this.description)
					.onChange(value => {
						this.description = value;
					});
				text.inputEl.rows = 3;
			});

		// Action buttons
		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText('Save record')
					.setCta()
					.onClick(() => {
						this.save('recorded');
					});
			})
			.addButton(button => {
				button
					.setButtonText('Save as draft')
					.onClick(() => {
						this.save('draft');
					});
			})
			.addButton(button => {
				button
					.setButtonText('Cancel')
					.onClick(() => {
						this.close();
						this.onCancel?.();
					});
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private save(saveMode: TransactionSaveMode = 'recorded') {
		if (this.amount <= 0) {
			alert('Please enter a valid amount');
			return;
		}

		// Parse tags
		const tags = this.tagsInput
			.split(',')
			.map(t => t.trim().toLowerCase())
			.filter(t => t.length > 0);

		// Add category to tags if not already present
		if (this.category && !tags.includes(this.category.toLowerCase())) {
			tags.push(this.category.toLowerCase());
		}

		const data: TransactionData = {
			type: this.type,
			amount: this.amount,
			currency: this.currency,
			dateTime: this.dateTime,
			description: this.description,
			area: this.normalizeWikiLink(this.area),
			project: this.normalizeWikiLink(this.project),
			tags: tags,
			category: this.category || tags[0] || 'uncategorized',
			source: 'manual'
		};

		this.onComplete?.(data, saveMode);
		this.close();
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

	private applyInitialData(initialData?: Partial<TransactionData>) {
		if (!initialData) {
			return;
		}

		if (typeof initialData.type === 'string') {
			this.type = initialData.type;
		}
		if (typeof initialData.amount === 'number') {
			this.amount = initialData.amount;
		}
		if (typeof initialData.currency === 'string' && initialData.currency.trim()) {
			this.currency = initialData.currency;
		}
		if (typeof initialData.description === 'string') {
			this.description = initialData.description;
		} else if (typeof initialData.comment === 'string') {
			this.description = initialData.comment;
		}
		if (typeof initialData.category === 'string') {
			this.category = initialData.category;
		}
		if (typeof initialData.dateTime === 'string' && initialData.dateTime.trim()) {
			this.dateTime = initialData.dateTime;
		}
		if (typeof initialData.area === 'string') {
			this.area = initialData.area;
		}
		if (typeof initialData.project === 'string') {
			this.project = initialData.project;
		}
		if (Array.isArray(initialData.tags)) {
			this.tagsInput = initialData.tags.join(', ');
		}
	}

	private normalizeWikiLink(value: string): string | undefined {
		const trimmed = value.trim();
		if (!trimmed) {
			return undefined;
		}
		if (/^\[\[.*\]\]$/.test(trimmed)) {
			return trimmed;
		}
		return `[[${trimmed}]]`;
	}

	private addLinkedNoteSetting(
		containerEl: HTMLElement,
		name: 'Area' | 'Project',
		description: string,
		placeholder: string,
		currentValue: string,
		suggestions: LinkedNoteSuggestion[],
		expectedType: 'area' | 'project',
		onChange: (value: string) => void,
	) {
		const setting = new Setting(containerEl)
			.setName(name)
			.setDesc(this.buildLinkedNoteDescription(description, suggestions, name.toLowerCase()));

		let hintEl: HTMLDivElement | null = null;
		setting.addText((text) => {
			this.attachSuggestionList(text, suggestions, expectedType);

			text
				.setPlaceholder(placeholder)
				.setValue(currentValue)
				.onChange((value) => {
					onChange(value);
					if (hintEl) {
						this.updateLinkedNoteHint(hintEl, value, expectedType, suggestions, name);
					}
				});

			hintEl = setting.controlEl.createDiv({ cls: 'mod-hint' });
			hintEl.style.marginTop = '6px';
			this.updateLinkedNoteHint(hintEl, currentValue, expectedType, suggestions, name);
		});
	}

	private attachSuggestionList(
		text: TextComponent,
		suggestions: LinkedNoteSuggestion[],
		listSuffix: string,
	) {
		if (suggestions.length === 0) {
			return;
		}

		const listId = `expense-manager-${listSuffix}-suggestions`;
		let datalist = this.contentEl.querySelector(`#${listId}`) as HTMLDataListElement | null;
		if (!datalist) {
			datalist = this.contentEl.createEl('datalist', { attr: { id: listId } });
			for (const suggestion of suggestions) {
				const option = datalist.createEl('option');
				option.value = suggestion.name;
				option.label = suggestion.path;
				option.textContent = suggestion.path;
			}
		}

		text.inputEl.setAttr('list', listId);
	}

	private updateLinkedNoteHint(
		hintEl: HTMLDivElement,
		value: string,
		expectedType: 'area' | 'project',
		suggestions: LinkedNoteSuggestion[],
		label: 'Area' | 'Project',
	) {
		const linkPath = this.extractLinkPath(value);
		const baseColor = 'var(--text-muted)';
		const successColor = 'var(--color-green, var(--text-success))';
		const warningColor = 'var(--color-orange, var(--text-warning))';

		if (!linkPath) {
			hintEl.style.color = baseColor;
			hintEl.setText(this.buildIdleHint(suggestions, label.toLowerCase()));
			return;
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
		if (!file) {
			hintEl.style.color = warningColor;
			hintEl.setText(`${label} not found: [[${linkPath}]]`);
			return;
		}

		const frontmatterType = this.readFrontmatterType(file);
		if (frontmatterType !== expectedType) {
			hintEl.style.color = warningColor;
			hintEl.setText(
				`${label} found at ${file.path}, but type is "${frontmatterType ?? 'missing'}" instead of "${expectedType}"`,
			);
			return;
		}

		hintEl.style.color = successColor;
		hintEl.setText(`${label} found: ${file.basename}`);
	}

	private buildLinkedNoteDescription(
		baseDescription: string,
		suggestions: LinkedNoteSuggestion[],
		label: string,
	): string {
		if (suggestions.length === 0) {
			return `${baseDescription} No ${label} notes with matching frontmatter type were found yet.`;
		}

		const preview = suggestions
			.slice(0, 3)
			.map((item) => item.name)
			.join(', ');
		const suffix = suggestions.length > 3 ? ` and ${suggestions.length - 3} more` : '';
		return `${baseDescription} Available: ${preview}${suffix}.`;
	}

	private buildIdleHint(suggestions: LinkedNoteSuggestion[], label: string): string {
		if (suggestions.length === 0) {
			return `No ${label} notes available yet.`;
		}

		const preview = suggestions
			.slice(0, 5)
			.map((item) => item.name)
			.join(', ');
		return `Suggestions: ${preview}`;
	}

	private getTypedNoteSuggestions(expectedType: 'area' | 'project'): LinkedNoteSuggestion[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.readFrontmatterType(file) === expectedType)
			.map((file) => ({
				name: file.basename,
				path: file.path,
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	private extractLinkPath(value: string): string | null {
		const trimmed = value.trim();
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
}
