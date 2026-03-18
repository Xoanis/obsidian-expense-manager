import { TransactionData, TransactionDetail } from '../types';
import { parseQrReceiptString, QrReceiptData, operationTypeToTransactionType } from './qr-parser';
import jsQR from 'jsqr';

/**
 * Response from ProverkaCheka API
 */
interface CheckResponse {
	code: number; // 0-5: 0-invalid, 1-success, 2-pending, 3-limit exceeded, 4-wait before retry, 5-other error
	first?: number; // 1-first time, 0-repeat request
	data?: {
		json?: {
			user?: string; // Organization
			retailPlaceAddres?: string; // Address
			userInn?: string; // INN
			ticketDate?: string; // Date (fallback)
			dateTime?: string; // Date and time (primary source)
			requestNumber?: string; // Receipt number
			shiftNumber?: string; // Shift number
			operator?: string; // Cashier
			operationType?: number; // 1-Income, 2-Income return, 3-Expense, 4-Expense return
			items?: Array<{
				name: string;
				price: number; // In kopecks
				quantity: number;
				sum: number; // In kopecks
			}>;
			nds18?: number; // VAT 20% (in kopecks)
			nds?: number; // VAT 10% (in kopecks)
			nds0?: number; // VAT 0% (in kopecks)
			ndsNo?: number; // VAT not taxable (in kopecks)
			totalSum?: number; // Total (in kopecks)
			cashTotalSum?: number; // Cash (in kopecks)
			ecashTotalSum?: number; // Card (in kopecks)
			taxationType?: number; // Tax type
			kktRegId?: string; // KKT reg number
			kktNumber?: string; // KKT serial number
			fiscalDriveNumber?: string; // FN
			fiscalDocumentNumber?: string; // FD
			fiscalSign?: string; // FP
		};
		html?: string;
	};
	request?: {
		qrurl?: string;
		qrfile?: string;
		qrraw?: string;
		manual?: {
			fn?: string;
			fd?: string;
			fp?: string;
			check_time?: string;
			type?: number;
			sum?: number;
		};
	};
}

/**
 * Client for ProverkaCheka REST API
 * https://proverkacheka.com/api/v1/check/get
 */
export class ProverkaChekaClient {
	private apiKey: string;
	private localOnly: boolean = false;
	private baseUrl = 'https://proverkacheka.com/api/v1/check/get';

	constructor(apiKey: string, localOnly: boolean = false) {
		this.apiKey = apiKey;
		this.localOnly = localOnly;
	}

	/**
	 * Decode QR code from image locally using jsQR library
	 */
	async decodeQrLocally(imageBlob: Blob): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');

			img.onload = () => {
				canvas.width = img.width;
				canvas.height = img.height;
				
				if (!ctx) {
					reject(new Error('Could not get canvas context'));
					return;
				}
				
				ctx.drawImage(img, 0, 0);
				
				const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
				const code = jsQR(imageData.data, imageData.width, imageData.height);
				
				if (code) {
					resolve(code.data);
				} else {
					resolve(null); // No QR code found
				}
			};

			img.onerror = () => {
				reject(new Error('Failed to load image'));
			};

			img.src = URL.createObjectURL(imageBlob);
		});
	}

	/**
	 * Create transaction data from local QR parsing (fallback when API fails)
	 */
	private createFromLocalQr(qrData: QrReceiptData): TransactionData {
		const now = new Date().toISOString();
		
		// Determine transaction type from operation type
		const type = qrData.n ? operationTypeToTransactionType(qrData.n) : 'expense';
		
		// Generate comment from available data
		let comment = 'Receipt';
		if (qrData.fn) {
			comment = `Receipt`;
		}
		
		// Build tags - no longer include fn, fp, i
		const tags: string[] = ['receipt', 'qr', 'local'];

		return {
			type: type,
			amount: qrData.amount || 0,
			currency: 'RUB',
			dateTime: qrData.dateTime || now,
			comment: comment,
			tags: tags,
			category: type === 'expense' ? 'Shopping' : 'Other',
			source: 'qr',
			details: [], // No item details from local QR
			// Store fiscal document numbers as separate properties
			fn: qrData.fn,
			fd: qrData.i, // 'i' in QR is the fiscal document number (ФД)
			fp: qrData.fp
		};
	}

	/**
	 * Process receipt with hybrid approach:
	 * 1. Try local QR decoding first
	 * 2. Send to ProverkaCheka API for detailed data (if not localOnly mode)
	 * 3. If API fails, use local QR data as fallback
	 */
	async processReceiptHybrid(imageBlob: Blob): Promise<{
		data: TransactionData;
		source: 'api' | 'local';
		hasError: boolean;
		error?: string;
	}> {
		try {
			// Step 1: Decode QR locally first
			const qrString = await this.decodeQrLocally(imageBlob);
			
			if (!qrString) {
				return {
					data: this.createEmptyTransaction(),
					source: 'local',
					hasError: true,
					error: 'No QR code found in image'
				};
			}
			
			// Parse QR string
			const qrData = parseQrReceiptString(qrString);
			
			if (!qrData) {
				return {
					data: this.createEmptyTransaction(),
					source: 'local',
					hasError: true,
					error: 'Invalid QR code format - not a receipt'
				};
			}
			
			// Step 2: Check if we should skip API and use local only
			if (this.localOnly) {
                console.log('Local-only mode enabled, will use local QR data');
				// Local-only mode - skip API call
				const localData = this.createFromLocalQr(qrData);
				return {
					data: localData,
					source: 'local',
					hasError: false
				};
			} else {
                console.log('Local-only mode disabled, will use API to process receipt');
            }
			
			// Step 3: Try to get detailed data from API
			try {
                console.log('Trying to process receipt using API');
				const apiData = await this.processReceiptImage(imageBlob);
                console.log('API data:', apiData);
				return {
					data: apiData,
					source: 'api',
					hasError: false
				};
			} catch (apiError) {
				// Step 4: API failed, use local QR data as fallback
				console.warn('ProverkaCheka API failed, using local QR data:', apiError);
				
				const localData = this.createFromLocalQr(qrData);
				return {
					data: localData,
					source: 'local',
					hasError: false,
					error: `API error: ${(apiError as Error).message}. Using local QR data.`
				};
			}
		} catch (error) {
			return {
				data: this.createEmptyTransaction(),
				source: 'local',
				hasError: true,
				error: (error as Error).message
			};
		}
	}

	/**
	 * Create empty transaction for error cases
	 */
	private createEmptyTransaction(): TransactionData {
		return {
			type: 'expense',
			amount: 0,
			currency: 'RUB',
			dateTime: new Date().toISOString(),
			comment: 'Failed to process receipt',
			tags: ['receipt', 'qr', 'error'],
			category: 'Other',
			source: 'qr'
		};
	}

	/**
	 * Send QR code image to API and parse receipt data
	 */
	async processReceiptImage(imageBlob: Blob): Promise<TransactionData> {
		if (!this.apiKey) {
			throw new Error('ProverkaCheka API token is not configured');
		}

		// Prepare form data with correct parameter names
		const formData = new FormData();
		formData.append('qrfile', imageBlob);
		formData.append('token', this.apiKey);

		// Make API request
		const response = await fetch(this.baseUrl, {
			method: 'POST',
			body: formData
		});

		if (!response.ok) {
			throw new Error(`API request failed with status ${response.status}`);
		}

		const data: CheckResponse = await response.json();

		// Handle response codes
		if (data.code === 0) {
			throw new Error('QR code is invalid or corrupted');
		} else if (data.code === 2) {
			throw new Error('Receipt data is still being processed. Please try again in a few seconds.');
		} else if (data.code === 3) {
			throw new Error('API request limit exceeded. Please try again later.');
		} else if (data.code === 4) {
			throw new Error('Please wait before making another request.');
		} else if (data.code === 5) {
			throw new Error('Failed to retrieve receipt data. Please check the QR code and try again.');
		} else if (data.code !== 1) {
			throw new Error(`Unknown API response code: ${data.code}`);
		}

		// Success (code === 1)
		if (!data.data?.json) {
			throw new Error('No receipt data received');
		}

		return this.parseApiResponse(data.data.json);
	}

	/**
	 * Parse API response into TransactionData
	 */
	private parseApiResponse(json: NonNullable<CheckResponse['data']>['json']): TransactionData {
		if (!json) {
			throw new Error('No data in API response');
		}

		// Get receipt date with priority: dateTime > ticketDate > current time
		let dateTime = new Date().toISOString();
		
		// First try to use dateTime field if available
		if (json.dateTime) {
			try {
				const apiDateTime = new Date(json.dateTime);
				if (!isNaN(apiDateTime.getTime())) {
					dateTime = apiDateTime.toISOString();
				} else {
					console.warn('Invalid dateTime format, will try ticketDate:', json.dateTime);
				}
			} catch (e) {
				console.warn('Could not parse dateTime, will try ticketDate:', json.dateTime);
			}
		}
		
		// If dateTime didn't work or wasn't present, try ticketDate
		if (dateTime === new Date().toISOString() && json.ticketDate) {
			try {
				const receiptDate = new Date(json.ticketDate);
				if (!isNaN(receiptDate.getTime())) {
					dateTime = receiptDate.toISOString();
				}
			} catch (e) {
				console.warn('Could not parse ticketDate, using current time:', json.ticketDate);
			}
		}
		
		// Convert total from kopecks to rubles
		const totalRubles = (json.totalSum || 0) / 100;
		
		// Extract items and convert prices from kopecks to rubles
		const details: TransactionDetail[] = [];
		if (json.items && json.items.length > 0) {
			for (const item of json.items) {
				details.push({
					name: item.name,
					price: item.price / 100, // Convert kopecks to rubles
					quantity: item.quantity,
					total: item.sum / 100 // Convert kopecks to rubles
				});
			}
		}

		// Determine transaction type from operationType
		// 1-Income (Приход), 2-Income return, 3-Expense, 4-Expense return
		let type: 'expense' | 'income' = 'expense';
		if (json.operationType === 1) {
			type = 'expense'; // Приход - this is when you PAY money (expense for customer)
		} else if (json.operationType === 2) {
			type = 'income'; // Возврат прихода - return of payment (income back to customer)
		} else if (json.operationType === 3) {
			type = 'income'; // Расход - when organization pays out (income for customer)
		} else if (json.operationType === 4) {
			type = 'expense'; // Возврат расхода - return of payout
		}

		// Generate comment from receipt info
		let comment = 'Receipt';
		if (json.user) {
			comment = `Receipt from ${json.user}`;
		} else if (json.kktRegId) {
			comment = `Receipt from KKT ${json.kktRegId}`;
		} else if (details.length > 0) {
			comment = `Receipt: ${details.slice(0, 3).map(d => d.name).join(', ')}`;
			if (details.length > 3) {
				comment += ` +${details.length - 3} more`;
			}
		}

		// Build tags with receipt metadata
		const tags: string[] = ['receipt', 'qr', 'ProverkaChekaAPI'];

		return {
			type: type,
			amount: totalRubles,
			currency: 'RUB',
			dateTime: dateTime,
			comment: comment,
			tags: tags,
			category: type === 'expense' ? 'Shopping' : 'Other',
			details: details,
			source: 'qr',
			
			// Store fiscal document numbers from API response
			fn: json.fiscalDriveNumber,
			fd: json.fiscalDocumentNumber,
			fp: json.fiscalSign
		};
	}

	/**
	 * Validate API token format
	 */
	static validateApiKey(apiKey: string): boolean {
		// Basic validation - should be non-empty string
		return typeof apiKey === 'string' && apiKey.length > 0;
	}
}
