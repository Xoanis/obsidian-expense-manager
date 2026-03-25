import { App, TFile } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData, TransactionType } from '../types';
import { ITelegramBotPluginAPIv1, CommandHandler, TextHandler, FileHandler } from '../../telegram_plugin_api';
import { ExpenseManagerSettings } from '../settings';
import { DuplicateTransactionError, ExpenseService } from '../services/expense-service';
import { ReportSyncService } from '../services/report-sync-service';
import { TelegramChartService } from '../services/telegram-chart-service';
import { ProverkaChekaClient } from '../utils/api-client';
import { formatMonthlyReportMessages, formatMonthlySummaryMessage } from '../utils/report-formatters';
import { PLUGIN_UNIT_NAME } from '../utils/constants';

interface ParsedTelegramTransactionInput {
	amount: number;
	comment: string;
	area?: string;
	project?: string;
}

export class TelegramHandler extends BaseHandler {
	private app: App;
	private expenseService: ExpenseService;
	private telegramApi: ITelegramBotPluginAPIv1 | null = null;
	private unitName = PLUGIN_UNIT_NAME;
	private settings: ExpenseManagerSettings;
	private reportSyncService: ReportSyncService;
	private telegramChartService: TelegramChartService;

	constructor(
		app: App,
		expenseService: ExpenseService,
		reportSyncService: ReportSyncService,
		telegramChartService: TelegramChartService,
		settings: ExpenseManagerSettings,
		telegramApi?: ITelegramBotPluginAPIv1
	) {
		super();
		this.app = app;
		this.expenseService = expenseService;
		this.reportSyncService = reportSyncService;
		this.telegramChartService = telegramChartService;
		this.settings = settings;
		this.telegramApi = telegramApi || null;
	}

	getName(): string {
		return 'telegram';
	}

	/**
	 * Initialize Telegram bot handlers
	 */
	async initialize(): Promise<boolean> {
		if (!this.telegramApi) {
			console.warn('Telegram API not available');
			return false;
		}

		// Register command handlers
		this.telegramApi.addCommandHandler('expense', this.handleExpenseCommand.bind(this), this.unitName);
		this.telegramApi.addCommandHandler('income', this.handleIncomeCommand.bind(this), this.unitName);
		this.telegramApi.addCommandHandler('finance_summary', this.handleFinanceSummaryCommand.bind(this), this.unitName);
		this.telegramApi.addCommandHandler('finance_report', this.handleFinanceReportCommand.bind(this), this.unitName);
		
		// Register text handler for parsing expense messages
		this.telegramApi.addTextHandler(this.handleTextMessage.bind(this), this.unitName);
		
		// Register file handler for receipt images
		this.telegramApi.addFileHandler(this.handleFileMessage.bind(this), this.unitName, 'image/*');

		return true;
	}


    parseArgs(args: string): ParsedTelegramTransactionInput | null {
		const trimmed = args.trim();
		if (!trimmed) {
			return null;
		}

		const [head, ...metadataParts] = trimmed.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
		if (!head) {
			return null;
		}

		const [amountStr, ...commentParts] = head.split(/\s+/);
		const amount = parseFloat(amountStr);
		const comment = commentParts.join(' ').trim();
		if (isNaN(amount) || !comment) {
			return null;
		}

		const metadata = this.parseMetadataParts(metadataParts);
		return {
			amount,
			comment,
			area: metadata.area,
			project: metadata.project,
		};
    }

    makeTransactionData(
		type: TransactionType,
		amount: number,
		comment: string,
		metadata?: { area?: string; project?: string },
	): TransactionData {
        return {
            type,
            amount,
            currency: 'RUB',
            dateTime: new Date().toISOString(),
            description: comment,
            area: metadata?.area,
            project: metadata?.project,
            tags: ['telegram'],
            category: 'Other',
            source: 'telegram'
        };
    }

	/**
	 * Handle /expense command
	 */
	private async handleExpenseCommand(args: string, processed_before: boolean): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

        const parsed_args = this.parseArgs(args);
        if (!parsed_args) {
            const message = 'To add an expense, send:\n/expense <amount> <description>\nOptional metadata: | area=Health | project=My Project\n\nExample:\n/expense 500 Lunch at cafe | area=Health';            
            return { processed: true, answer: message };
        } else {
            try {
                const { amount, comment, area, project } = parsed_args;
                await this.expenseService.createTransaction(
					this.makeTransactionData('expense', amount, comment, { area, project }),
				);
                const emoji = '💸';

                console.log(`Saved expense: ${amount.toFixed(2)} RUB ${comment}`);

                return { processed: true, answer: `${emoji} Saved: ${amount.toFixed(2)} RUB ${comment}` };
            } catch (error) {
				if (error instanceof DuplicateTransactionError) {
					return { processed: true, answer: 'Duplicate transaction found. Skipping save.' };
				}
                return { processed: true, answer: 'Error saving transaction: ' + (error as Error).message };
            }
        }
	}

	/**
	 * Handle /income command
	 */
	private async handleIncomeCommand(args: string, processed_before: boolean): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

        const parsed_args = this.parseArgs(args);
        if (!parsed_args) {
            const message = 'To add income, send:\n/income <amount> <description>\nOptional metadata: | area=Career | project=My Project\n\nExample:\n/income 50000 Salary | area=Career';            
            return { processed: true, answer: message };
        } else {
            try {
                const { amount, comment, area, project } = parsed_args;
                await this.expenseService.createTransaction(
					this.makeTransactionData('income', amount, comment, { area, project }),
				);
                
                const emoji = '💰';
                console.log(`Saved income: ${amount.toFixed(2)} RUB ${comment}`);

                return { processed: true, answer: `${emoji} Saved: ${amount.toFixed(2)} RUB ${comment}` };
            } catch (error) {
				if (error instanceof DuplicateTransactionError) {
					return { processed: true, answer: 'Duplicate transaction found. Skipping save.' };
				}
                return { processed: true, answer: 'Error saving transaction: ' + (error as Error).message };
            }
        }
	}

	/**
	 * Handle text messages with expense/income data
	 */
	private async handleTextMessage(text: string, processed_before: boolean): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

		const match = text.match(/^\/?(expense|income)\s+(.+)$/i);
		if (!match) {
			return { processed: false, answer: null };
		}

		const [, typeStr, payload] = match;
		const type: TransactionType = typeStr.toLowerCase() === 'income' ? 'income' : 'expense';
		const parsed = this.parseArgs(payload);
		if (!parsed || parsed.amount <= 0) {
            const message = 'Invalid amount. Please use format: /expense 500 Comment | area=Health | project=My Project';
			return { processed: true, answer: message };
		}

		try {
			const data = this.makeTransactionData(type, parsed.amount, parsed.comment, {
				area: parsed.area,
				project: parsed.project,
			});

			await this.expenseService.createTransaction(data);
			console.log(`Saved ${type}: ${parsed.amount.toFixed(2)} RUB ${parsed.comment}`);
			const emoji = type === 'expense' ? '💸' : '💰';
            const message = `${emoji} Saved: ${type} ${parsed.amount.toFixed(2)} RUB\n${parsed.comment}`;
			return { processed: true, answer: message };
		} catch (error) {
			if (error instanceof DuplicateTransactionError) {
				return { processed: true, answer: 'Duplicate transaction found. Skipping save.' };
			}
			const message = 'Error saving transaction: ' + (error as Error).message;
			return { processed: true, answer: message };
		}
	}

	/**
	 * Handle file messages (receipt images)
	 */
	private async handleFileMessage(file: TFile, processed_before: boolean, caption?: string): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

		// Check if file is image
		if (!file.extension.match(/^(jpg|jpeg|png|gif|webp)$/i)) {
            console.log("Not an image file")
			return { processed: false, answer: null };
		}

		try {
			// Read file as blob
			const arrayBuffer = await this.app.vault.readBinary(file);
			const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });

			// Create ProverkaCheka client with current settings
			const client = new ProverkaChekaClient(
				this.settings.proverkaChekaApiKey, 
				this.settings.localQrOnly
			);
			
			// Use hybrid processing
			const result = await client.processReceiptHybrid(blob);
			
			if (result.hasError) {
                const message = `❌ Error processing receipt: ${result.error || 'Failed to decode QR code'}`;

				return { processed: true, answer: message };
			}
			
			// Update description with caption if provided
			if (caption && caption.trim()) {
				const parsedCaption = this.parseCaption(caption);
				result.data.description = parsedCaption.comment || result.data.description;
				result.data.area = parsedCaption.area;
				result.data.project = parsedCaption.project;
			}
			result.data.artifactBytes = arrayBuffer;
			result.data.artifactFileName = file.name;
			result.data.artifactMimeType = 'image/jpeg';
			
			// Save transaction
			await this.expenseService.createTransaction(result.data);
			console.log(`Saved ${result.data.type}: ${result.data.amount.toFixed(2)} RUB ${result.data.description}`);
			// Send confirmation
			const emoji = result.data.type === 'expense' ? '💸' : '💰';
			const sourceText = result.source === 'api' ? 'via ProverkaCheka API' : 'via local QR';

            const message = `${emoji} Saved: ${result.data.type} ${result.data.amount.toFixed(2)} RUB\n` +
				`${result.data.description}\n` +
				`Source: ${sourceText}`;

			return { processed: true, answer: message };
		} catch (error) {
			if (error instanceof DuplicateTransactionError) {
				return { processed: true, answer: 'Duplicate transaction found. Skipping save.' };
			}
			const message = 'Error processing image: ' + (error as Error).message;

			return { processed: true, answer: message };
		}
	}

	/**
	 * Direct handler for expense/income (not used in base class interface)
	 */
	async handle(): Promise<HandlerResult> {
		// This is handled via Telegram commands, not direct invocation
		return {
			success: false,
			error: 'Telegram handler works via bot commands, not direct invocation'
		};
	}

	private async handleFinanceSummaryCommand(args: string, processed_before: boolean): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

		try {
			const reportDate = this.parseMonthlyReportArgument(args);
			const report = await this.reportSyncService.generateStandardPeriodReport('month', reportDate);
			const previousReport = await this.reportSyncService.generateStandardPeriodReport(
				'month',
				new Date(reportDate.getFullYear(), reportDate.getMonth() - 1, 1),
			);
			return {
				processed: true,
				answer: formatMonthlySummaryMessage(report, previousReport),
			};
		} catch (error) {
			return {
				processed: true,
				answer: 'Error generating finance summary: ' + (error as Error).message,
			};
		}
	}

	private async handleFinanceReportCommand(args: string, processed_before: boolean): Promise<any> {
		if (processed_before) {
			return { processed: false, answer: null };
		}

		try {
			const reportDate = this.parseMonthlyReportArgument(args);
			const report = await this.reportSyncService.generateStandardPeriodReport('month', reportDate);
			const previousReport = await this.reportSyncService.generateStandardPeriodReport(
				'month',
				new Date(reportDate.getFullYear(), reportDate.getMonth() - 1, 1),
			);
			const messages = formatMonthlyReportMessages(report, previousReport);
			if (this.telegramApi) {
				for (const extraMessage of messages.slice(1)) {
					await this.telegramApi.sendMessage(extraMessage);
				}
			}
			return {
				processed: true,
				answer: messages[0] ?? 'No data for this month.',
			};
		} catch (error) {
			return {
				processed: true,
				answer: 'Error generating finance report: ' + (error as Error).message,
			};
		}
	}

	private parseCaption(caption: string): { comment: string; area?: string; project?: string } {
		const parts = caption
			.split('|')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length === 0) {
			return { comment: '' };
		}

		const [comment, ...metadataParts] = parts;
		const metadata = this.parseMetadataParts(metadataParts);
		return {
			comment,
			area: metadata.area,
			project: metadata.project,
		};
	}

	private parseMetadataParts(parts: string[]): { area?: string; project?: string } {
		const result: { area?: string; project?: string } = {};
		for (const part of parts) {
			const [rawKey, ...rawValueParts] = part.split('=');
			if (!rawKey || rawValueParts.length === 0) {
				continue;
			}

			const key = rawKey.trim().toLowerCase();
			const rawValue = rawValueParts.join('=').trim();
			if (!rawValue) {
				continue;
			}

			if (key === 'area') {
				result.area = this.normalizeWikiLink(rawValue);
			}
			if (key === 'project') {
				result.project = this.normalizeWikiLink(rawValue);
			}
		}
		return result;
	}

	private normalizeWikiLink(value: string): string {
		const trimmed = value.trim();
		if (/^\[\[.*\]\]$/.test(trimmed)) {
			return trimmed;
		}
		return `[[${trimmed}]]`;
	}

	private parseMonthlyReportArgument(rawArgs: string | undefined): Date {
		const value = rawArgs?.trim().toLowerCase() ?? '';
		const now = new Date();
		if (!value || value === 'current' || value === 'now' || value === 'this') {
			return new Date(now.getFullYear(), now.getMonth(), 1);
		}
		if (value === 'prev' || value === 'previous') {
			return new Date(now.getFullYear(), now.getMonth() - 1, 1);
		}

		const monthMatch = value.match(/^(\d{4})-(\d{2})$/);
		if (monthMatch) {
			const year = Number(monthMatch[1]);
			const month = Number(monthMatch[2]);
			if (month >= 1 && month <= 12) {
				return new Date(year, month - 1, 1);
			}
		}

		return new Date(now.getFullYear(), now.getMonth(), 1);
	}
}
