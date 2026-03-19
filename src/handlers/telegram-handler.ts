import { App, TFile } from 'obsidian';
import { BaseHandler } from './base-handler';
import { HandlerResult, TransactionData, TransactionType } from '../types';
import { ITelegramBotPluginAPIv1, CommandHandler, TextHandler, FileHandler } from '../../telegram_plugin_api';
import { ExpenseManagerSettings } from '../settings';
import { ExpenseService } from '../services/expense-service';
import { ProverkaChekaClient } from '../utils/api-client';
import { PLUGIN_UNIT_NAME } from '../utils/constants';

export class TelegramHandler extends BaseHandler {
	private app: App;
	private expenseService: ExpenseService;
	private telegramApi: ITelegramBotPluginAPIv1 | null = null;
	private unitName = PLUGIN_UNIT_NAME;
	private settings: ExpenseManagerSettings;

	constructor(
		app: App,
		expenseService: ExpenseService,
		settings: ExpenseManagerSettings,
		telegramApi?: ITelegramBotPluginAPIv1
	) {
		super();
		this.app = app;
		this.expenseService = expenseService;
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
		
		// Register text handler for parsing expense messages
		this.telegramApi.addTextHandler(this.handleTextMessage.bind(this), this.unitName);
		
		// Register file handler for receipt images
		this.telegramApi.addFileHandler(this.handleFileMessage.bind(this), this.unitName, 'image/*');

		return true;
	}


    parseArgs(args: string): { amount: number, comment: string } | null {
        // Split by the first space(s) found
        const [amountStr, ...commentParts] = args.trim().split(/\s+/);
        
        // Join the rest of the array back into a single string
        const comment = commentParts.join(' ');
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || !comment) {
            return null;
        }

        return { amount, comment };
    }

    makeTransactionData(type: TransactionType, amount: number, comment: string): TransactionData {
        return {
            type,
            amount,
            currency: 'RUB',
            dateTime: new Date().toISOString(),
            comment,
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
            const message = 'To add an expense, send:\n/expense <amount> <comment>\n\nExample:\n/expense 500 Lunch at cafe';            
            return { processed: true, answer: message };
        } else {
            try {
                const { amount, comment } = parsed_args;
                await this.expenseService.createTransaction(this.makeTransactionData('expense', amount, comment));                
                const emoji = '💸';

                console.log(`Saved expense: ${amount.toFixed(2)} RUB ${comment}`);

                return { processed: true, answer: `${emoji} Saved: ${amount.toFixed(2)} RUB ${comment}` };
            } catch (error) {
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
            const message = 'To add income, send:\n/income <amount> <comment>\n\nExample:\n/income 50000 Salary';            
            return { processed: true, answer: message };
        } else {
            try {
                const { amount, comment } = parsed_args;
                await this.expenseService.createTransaction(this.makeTransactionData('income', amount, comment));
                
                const emoji = '💰';
                console.log(`Saved income: ${amount.toFixed(2)} RUB ${comment}`);

                return { processed: true, answer: `${emoji} Saved: ${amount.toFixed(2)} RUB ${comment}` };
            } catch (error) {
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

		// Parse text like "/expense 500 Lunch" or "500 Lunch"
		const match = text.match(/^\/?(expense|income)\s+([\d.]+)\s+(.+)$/i);
		if (!match) {
			return { processed: false, answer: null };
		}

		const [, typeStr, amountStr, comment] = match;
		const type: TransactionType = typeStr.toLowerCase() === 'income' ? 'income' : 'expense';
		const amount = parseFloat(amountStr);

		if (isNaN(amount) || amount <= 0) {
            const message = 'Invalid amount. Please use format: /expense 500 Comment';
			return { processed: true, answer: message };
		}

		try {
			const data: TransactionData = {
				type,
				amount,
				currency: 'RUB',
				dateTime: new Date().toISOString(),
				comment: comment.trim(),
				tags: ['telegram'],
				category: type === 'expense' ? 'Other' : 'Other',
				source: 'telegram'
			};

			await this.expenseService.createTransaction(data);
			console.log(`Saved ${type}: ${amount.toFixed(2)} RUB ${comment}`);
			const emoji = type === 'expense' ? '💸' : '💰';
            const message = `${emoji} Saved: ${type} ${amount.toFixed(2)} RUB\n${comment}`;
			return { processed: true, answer: message };
		} catch (error) {
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
			
			// Update comment with caption if provided
			if (caption && caption.trim()) {
				result.data.comment = caption.trim();
			}
			
			// Save transaction
			await this.expenseService.createTransaction(result.data);
			console.log(`Saved ${result.data.type}: ${result.data.amount.toFixed(2)} RUB ${result.data.comment}`);
			// Send confirmation
			const emoji = result.data.type === 'expense' ? '💸' : '💰';
			const sourceText = result.source === 'api' ? 'via ProverkaCheka API' : 'via local QR';

            const message = `${emoji} Saved: ${result.data.type} ${result.data.amount.toFixed(2)} RUB\n` +
				`${result.data.comment}\n` +
				`Source: ${sourceText}`;

			return { processed: true, answer: message };
		} catch (error) {
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
}
