import { App, Modal, Setting } from 'obsidian';

export class FinanceRuleInputModal extends Modal {
	private value: string;
	private settled = false;

	onSubmit: ((value: string) => void) | null = null;
	onSecondaryAction: (() => void) | null = null;
	onCancel: (() => void) | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly placeholder: string,
		private readonly secondaryActionLabel?: string,
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
			.setName('Record')
			.setDesc('Examples: `expense 500 Lunch | area=Health`, `+5000 Bonus`, or `t=20260316T1007&s=1550.00&fn=...`')
			.addTextArea((text) => {
				text
					.setPlaceholder(this.placeholder)
					.setValue(this.value)
					.onChange((value) => {
						this.value = value;
					});
				text.inputEl.rows = 4;
			});

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText('Review')
					.setCta()
					.onClick(() => {
						this.submit();
					});
			})
			.addButton((button) => {
				if (!this.secondaryActionLabel) {
					return;
				}

				button
					.setButtonText(this.secondaryActionLabel)
					.onClick(() => {
						this.settled = true;
						this.close();
						this.onSecondaryAction?.();
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

		const inputEl = contentEl.querySelector('textarea');
		inputEl?.focus();
		inputEl?.addEventListener('keydown', (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
				event.preventDefault();
				this.submit();
			}
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
