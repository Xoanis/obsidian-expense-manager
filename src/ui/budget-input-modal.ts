import { App, Modal, Setting } from 'obsidian';

export class BudgetInputModal extends Modal {
	private value: string;
	private settled = false;

	onSubmit: ((value: string) => void) | null = null;
	onCancel: (() => void) | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly placeholder: string,
		initialValue = '',
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: this.title });
		contentEl.createEl('p', { text: this.description });

		new Setting(contentEl)
			.setName('Budget')
			.setDesc('Use a number like `50000` or `50000.50`. Send `-` to clear the budget.')
			.addText((text) => {
				text
					.setPlaceholder(this.placeholder)
					.setValue(this.value)
					.onChange((value) => {
						this.value = value;
					});
				text.inputEl.focus();
				text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						this.submit();
					}
				});
			});

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText('Set budget')
					.setCta()
					.onClick(() => {
						this.submit();
					});
			})
			.addButton((button) => {
				button
					.setButtonText('Cancel')
					.onClick(() => {
						this.settled = true;
						this.close();
						this.onCancel?.();
					});
			});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) {
			this.onCancel?.();
		}
	}

	private submit() {
		const trimmed = this.value.trim();
		if (!trimmed) {
			return;
		}

		this.settled = true;
		this.onSubmit?.(trimmed);
		this.close();
	}
}
