import { App, Modal, Setting, Notice } from 'obsidian';
import { TransactionData } from '../types';
import { ProverkaChekaClient } from '../utils/api-client';
import { ExpenseModal } from './expense-modal';

export class QrModal extends Modal {
	private client: ProverkaChekaClient;
	private autoSave: boolean;
	private selectedFile: File | null = null;
	private isProcessing: boolean = false;
	private processedData: TransactionData | null = null;

	onComplete: ((data: TransactionData) => void) | null = null;
	onCancel: (() => void) | null = null;

	constructor(
		app: App,
		client: ProverkaChekaClient,
		autoSave: boolean = false
	) {
		super(app);
		this.client = client;
		this.autoSave = autoSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Scan Receipt QR Code' });

		// Instructions
		contentEl.createEl('p', { 
			text: 'Upload a photo of the receipt QR code. The image will be sent to proverkacheka.com API for processing.' 
		});

		// File upload area
		const uploadContainer = contentEl.createDiv({ cls: 'qr-upload-container' });
		uploadContainer.style.cssText = `
			border: 2px dashed var(--background-modifier-border);
			border-radius: 8px;
			padding: 40px 20px;
			text-align: center;
			margin: 20px 0;
			cursor: pointer;
			transition: border-color 0.2s;
		`;

		uploadContainer.addEventListener('mouseenter', () => {
			uploadContainer.style.borderColor = 'var(--interactive-accent)';
		});
		uploadContainer.addEventListener('mouseleave', () => {
			uploadContainer.style.borderColor = 'var(--background-modifier-border)';
		});

		uploadContainer.createEl('p', { text: '📷 Click to select or drag & drop image here' });
		uploadContainer.createEl('p', { 
			text: 'Supported formats: JPG, PNG, WEBP',
			cls: 'mod-hint'
		});

		// Hidden file input
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = 'image/*';
		fileInput.style.display = 'none';
		contentEl.appendChild(fileInput);

		// Click handler
		uploadContainer.addEventListener('click', () => {
			fileInput.click();
		});

		// Drop handler
		uploadContainer.addEventListener('dragover', (e) => {
			e.preventDefault();
			uploadContainer.style.borderColor = 'var(--interactive-accent)';
		});

		uploadContainer.addEventListener('dragleave', () => {
			uploadContainer.style.borderColor = 'var(--background-modifier-border)';
		});

		uploadContainer.addEventListener('drop', (e) => {
			e.preventDefault();
			uploadContainer.style.borderColor = 'var(--background-modifier-border)';
			
			if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
				this.handleFileSelect(e.dataTransfer.files[0]);
			}
		});

		// File input change handler
		fileInput.addEventListener('change', (e) => {
			if (e.target instanceof HTMLInputElement && e.target.files && e.target.files.length > 0) {
				this.handleFileSelect(e.target.files[0]);
			}
		});

		// Preview area
		const previewArea = contentEl.createDiv({ cls: 'qr-preview-area' });
		previewArea.style.cssText = `
			margin-top: 20px;
			text-align: center;
			display: none;
		`;

		const previewImg = previewArea.createEl('img');
		previewImg.style.cssText = 'max-width: 100%; max-height: 300px; border-radius: 8px;';
		
		// Process button (appears after file selection when autoSave is off)
		const processButtonContainer = contentEl.createDiv({ cls: 'process-button-container' });
		processButtonContainer.style.cssText = 'margin-top: 15px; text-align: center; display: none;';
		
		const processButton = processButtonContainer.createEl('button', { text: '🔍 Process Receipt' });
		processButton.className = 'mod-cta';
		processButton.onclick = () => this.processReceipt();
		
		// Processing indicator
		const processingIndicator = contentEl.createDiv({ cls: 'processing-indicator' });
		processingIndicator.style.cssText = `
			text-align: center;
			padding: 20px;
			display: none;
		`;
		processingIndicator.createEl('div', { text: '⏳ Processing receipt...' });
		processingIndicator.createEl('p', { 
			text: 'This may take a few seconds',
			cls: 'mod-hint'
		});

		// Action buttons (initially hidden)
		const buttonContainer = contentEl.createDiv({ cls: 'qr-button-container' });
		buttonContainer.style.cssText = 'margin-top: 20px; display: none; justify-content: flex-end; gap: 10px;';

		const reviewButton = buttonContainer.createEl('button', { text: 'Review & Edit' });
		reviewButton.className = 'mod-cta';
		reviewButton.onclick = () => this.reviewAndEdit();

		const saveButton = buttonContainer.createEl('button', { text: 'Save Directly' });
		saveButton.onclick = () => this.saveDirectly();

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.onclick = () => {
			this.close();
			this.onCancel?.();
		};

		// Store references for updates
		(this as any).previewArea = previewArea;
		(this as any).previewImg = previewImg;
		(this as any).processButtonContainer = processButtonContainer;
		(this as any).processingIndicator = processingIndicator;
		(this as any).buttonContainer = buttonContainer;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private handleFileSelect(file: File) {
		this.selectedFile = file;

		// Show preview
		const reader = new FileReader();
		reader.onload = (e) => {
			if (e.target?.result) {
				(this as any).previewImg.src = e.target.result as string;
				(this as any).previewArea.style.display = 'block';
				
				// Show process button if autoSave is off
				if (!this.autoSave) {
					(this as any).processButtonContainer.style.display = 'block';
				} else {
					// Auto-process if enabled
					this.processReceipt();
				}
			}
		};
		reader.readAsDataURL(file);
	}

	private async processReceipt() {
		if (!this.selectedFile || this.isProcessing) return;

		this.isProcessing = true;
		(this as any).processButtonContainer.style.display = 'none';
		(this as any).processingIndicator.style.display = 'block';
		(this as any).buttonContainer.style.display = 'none';

		try {
			// Use hybrid processing: local QR first, then API fallback
			const result = await this.client.processReceiptHybrid(this.selectedFile);
			
			if (result.hasError) {
				new Notice(`Error: ${result.error || 'Failed to process receipt'}`);
				console.error('QR processing error:', result.error);
				// Show process button again on error so user can retry
				(this as any).processButtonContainer.style.display = 'block';
				return;
			}
			
			this.processedData = result.data;
			
			// Show success message with source info
			const sourceText = result.source === 'api' ? 'via ProverkaCheka API' : 'via local QR';
			new Notice(`Receipt processed successfully (${sourceText})!`);
			
			if (this.autoSave) {
				// Save directly
				this.saveDirectly();
			} else {
				// Show review button
				(this as any).buttonContainer.style.display = 'flex';
			}
		} catch (error) {
			new Notice(`Error: ${(error as Error).message}`);
			console.error('QR processing error:', error);
			// Show process button again on error so user can retry
			(this as any).processButtonContainer.style.display = 'block';
		} finally {
			this.isProcessing = false;
			(this as any).processingIndicator.style.display = 'none';
		}
	}

	private reviewAndEdit() {
		if (!this.processedData) return;

		this.close();

		// Open expense modal with pre-filled data
		const editModal = new ExpenseModal(this.app, 'expense', this.processedData.currency, []);
		
		// Pre-fill with processed data
		(editModal as any).amount = this.processedData.amount;
		(editModal as any).comment = this.processedData.comment;
		(editModal as any).tagsInput = this.processedData.tags.join(', ');
		(editModal as any).category = this.processedData.category || '';

		editModal.onComplete = (data: TransactionData) => {
			// Keep the details from original processing
			data.details = this.processedData?.details;
			data.source = 'qr';
			this.onComplete?.(data);
		};

		editModal.onCancel = () => {
			this.onCancel?.();
		};

		editModal.open();
	}

	private saveDirectly() {
		if (!this.processedData) return;
		this.onComplete?.(this.processedData);
		this.close();
	}
}
