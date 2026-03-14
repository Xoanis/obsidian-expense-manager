import { TransactionData, TransactionDetail } from '../types';

/**
 * Response from ProverkaCheka API
 */
interface CheckResponse {
	success: boolean;
	error?: string;
	result?: {
		json?: {
			user?: string;
			requestsLimit?: number;
			calculated?: number;
			total?: number;
			ecr_registration?: {
				rn_kkt?: string;
			};
			items?: Array<{
				name: string;
				price: number;
				quantity: number;
				sum: number;
			}>;
		};
	};
}

/**
 * Client for ProverkaCheka REST API
 * https://proverkacheka.com/api/v1/check/get
 */
export class ProverkaChekaClient {
	private apiKey: string;
	private baseUrl = 'https://proverkacheka.com/api/v1/check/get';

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	/**
	 * Send QR code image to API and parse receipt data
	 */
	async processReceiptImage(imageBlob: Blob): Promise<TransactionData> {
		if (!this.apiKey) {
			throw new Error('ProverkaCheka API key is not configured');
		}

		// Convert blob to base64
		const base64Image = await this.blobToBase64(imageBlob);

		// Prepare form data
		const formData = new FormData();
		formData.append('api_key', this.apiKey);
		formData.append('check_image', imageBlob);

		// Make API request
		const response = await fetch(this.baseUrl, {
			method: 'POST',
			body: formData
		});

		if (!response.ok) {
			throw new Error(`API request failed with status ${response.status}`);
		}

		const data: CheckResponse = await response.json();

		if (!data.success || !data.result?.json) {
			throw new Error(data.error || 'Failed to parse receipt');
		}

		return this.parseApiResponse(data.result.json);
	}

	/**
	 * Parse API response into TransactionData
	 */
	private parseApiResponse(json: NonNullable<CheckResponse['result']>['json']): TransactionData {
		if (!json) {
			throw new Error('No data in API response');
		}

		const now = new Date().toISOString();
		
		// Calculate total amount
		const total = json.total || json.calculated || 0;
		
		// Extract items
		const details: TransactionDetail[] = [];
		if (json.items && json.items.length > 0) {
			for (const item of json.items) {
				details.push({
					name: item.name,
					price: item.price,
					quantity: item.quantity,
					total: item.sum
				});
			}
		}

		// Generate comment from store info or first few items
		let comment = 'Receipt';
		if (json.ecr_registration?.rn_kkt) {
			comment = `Receipt from KKT ${json.ecr_registration.rn_kkt}`;
		} else if (details.length > 0) {
			comment = `Receipt: ${details.slice(0, 3).map(d => d.name).join(', ')}`;
			if (details.length > 3) {
				comment += ` +${details.length - 3} more`;
			}
		}

		// Extract user phone if available
		const userPhone = json.user || '';
		const tags: string[] = ['receipt', 'qr'];
		if (userPhone) {
			tags.push('online-check');
		}

		return {
			type: 'expense',
			amount: total,
			currency: 'RUB',
			dateTime: now,
			comment: comment,
			tags: tags,
			category: 'Shopping',
			details: details,
			source: 'qr'
		};
	}

	/**
	 * Convert Blob to base64 string
	 */
	private blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * Validate API key format
	 */
	static validateApiKey(apiKey: string): boolean {
		// Basic validation - should be non-empty string
		return typeof apiKey === 'string' && apiKey.length > 0;
	}
}
