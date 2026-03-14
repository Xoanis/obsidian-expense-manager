import { App, Modal, Setting, TextComponent, DropdownComponent } from 'obsidian';
import { TransactionData, TransactionType } from '../types';

export class ExpenseModal extends Modal {
	private amount: number = 0;
	private type: TransactionType = 'expense';
	private currency: string = 'RUB';
	private comment: string = '';
	private category: string = '';
	private tagsInput: string = '';
	private dateTime: string = new Date().toISOString();
	
	private categories: string[] = [];
	
	onComplete: ((data: TransactionData) => void) | null = null;
	onCancel: (() => void) | null = null;

	constructor(
		app: App,
		defaultType: TransactionType = 'expense',
		defaultCurrency: string = 'RUB',
		categories: string[] = []
	) {
		super(app);
		this.type = defaultType;
		this.currency = defaultCurrency;
		this.categories = categories;
		if (categories.length > 0) {
			this.category = categories[0];
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: `${this.type === 'expense' ? 'Add Expense' : 'Add Income'}` });

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
						// Update header
						contentEl.querySelector('h2')?.setText(
							this.type === 'expense' ? 'Add Expense' : 'Add Income'
						);
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

		// Comment/Description
		new Setting(contentEl)
			.setName('Comment')
			.addTextArea(text => {
				text
					.setPlaceholder('What was this for?')
					.setValue(this.comment)
					.onChange(value => {
						this.comment = value;
					});
				text.inputEl.rows = 3;
			});

		// Action buttons
		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText('Save')
					.setCta()
					.onClick(() => {
						this.save();
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

	private save() {
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
			comment: this.comment,
			tags: tags,
			category: this.category || tags[0] || 'uncategorized',
			source: 'manual'
		};

		this.onComplete?.(data);
		this.close();
	}
}
