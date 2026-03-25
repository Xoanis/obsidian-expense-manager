import { App, Modal, Notice, Setting } from 'obsidian';
import { createCustomPeriodDescriptor, formatDateKey } from '../utils/report-periods';
import { ReportPeriodDescriptor } from '../types';

export class ReportPeriodModal extends Modal {
	private startDateValue: string;
	private endDateValue: string;

	constructor(
		app: App,
		private readonly onSubmit: (descriptor: ReportPeriodDescriptor) => Promise<void>,
	) {
		super(app);
		const now = new Date();
		const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
		this.startDateValue = formatDateKey(startOfMonth);
		this.endDateValue = formatDateKey(now);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Generate finance report' });

		new Setting(contentEl)
			.setName('Start date')
			.addText((text) => {
				text.inputEl.type = 'date';
				text.setValue(this.startDateValue);
				text.onChange((value) => {
					this.startDateValue = value;
				});
			});

		new Setting(contentEl)
			.setName('End date')
			.addText((text) => {
				text.inputEl.type = 'date';
				text.setValue(this.endDateValue);
				text.onChange((value) => {
					this.endDateValue = value;
				});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Generate')
					.setCta()
					.onClick(async () => {
						const descriptor = this.buildDescriptor();
						if (!descriptor) {
							return;
						}

						await this.onSubmit(descriptor);
						this.close();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('Cancel')
					.onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private buildDescriptor(): ReportPeriodDescriptor | null {
		const startDate = new Date(`${this.startDateValue}T00:00:00`);
		const endDate = new Date(`${this.endDateValue}T00:00:00`);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			new Notice('Please select valid start and end dates.');
			return null;
		}

		if (startDate.getTime() > endDate.getTime()) {
			new Notice('Start date must be earlier than end date.');
			return null;
		}

		return createCustomPeriodDescriptor(startDate, endDate);
	}
}
