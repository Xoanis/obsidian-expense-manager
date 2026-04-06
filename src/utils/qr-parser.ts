/**
 * Parse QR code raw string from receipt according to 54-FZ standard
 * Format: t=20260316T1007&s=1550.00&fn=9999078900012345&i=12345&fp=2890123456&n=1
 */
export interface QrReceiptData {
	/** Date and time (format: YYYYMMDDTHHMM) */
	dateTime?: string;
	
	/** Total amount in rubles */
	amount?: number;
	
	/** Fiscal drive number */
	fn?: string;
	
	/** Document number */
	i?: string;
	
	/** Fiscal sign */
	fp?: string;
	
	/** Operation type: 1=Income, 2=Income return, 3=Expense, 4=Expense return */
	n?: number;
}

const RECEIPT_QR_KEYS = new Set(['t', 's', 'fn', 'i', 'fp', 'n']);

export function looksLikeRawReceiptQrString(value: string): boolean {
	if (!value || typeof value !== 'string') {
		return false;
	}

	const normalized = value.trim().replace(/^\?/, '');
	if (!normalized) {
		return false;
	}

	// Receipt QR payload is expected to be a compact key=value&key=value string,
	// not a full email body, URL, or prose fragment.
	if (normalized.includes('://') || /[\r\n]/.test(normalized) || /\s/.test(normalized)) {
		return false;
	}

	const pairs = normalized.split('&').filter(Boolean);
	if (pairs.length < 3) {
		return false;
	}

	let recognizedKeys = 0;
	let hasFn = false;
	let hasStrongReceiptField = false;
	for (const pair of pairs) {
		const separatorIndex = pair.indexOf('=');
		if (separatorIndex <= 0 || separatorIndex === pair.length - 1) {
			return false;
		}

		const key = pair.slice(0, separatorIndex).trim();
		const valuePart = pair.slice(separatorIndex + 1).trim();
		if (!key || !valuePart) {
			return false;
		}

		if (RECEIPT_QR_KEYS.has(key)) {
			recognizedKeys += 1;
		}
		if (key === 'fn') {
			hasFn = true;
		}
		if (key === 't' || key === 's' || key === 'i' || key === 'fp') {
			hasStrongReceiptField = true;
		}
	}

	return hasFn && hasStrongReceiptField && recognizedKeys >= 3;
}

export function parseQrReceiptString(qrString: string): QrReceiptData | null {
	if (!qrString || typeof qrString !== 'string') {
		return null;
	}

	const normalized = qrString.trim().replace(/^\?/, '');
	if (!normalized) {
		return null;
	}

	const result: QrReceiptData = {};
	
	// Split by & to get key=value pairs
	const pairs = normalized.split('&');
	
	for (const pair of pairs) {
		const [key, value] = pair.split('=');
		
		if (!key || value === undefined) {
			continue;
		}
		
		switch (key) {
			case 't':
				// Time format: YYYYMMDDTHHMM
				result.dateTime = parseDateTime(value);
				break;
				
			case 's':
				// Sum in rubles
				result.amount = parseFloat(value);
				if (isNaN(result.amount)) {
					result.amount = undefined;
				}
				break;
				
			case 'fn':
				// Fiscal drive number
				result.fn = value;
				break;
				
			case 'i':
				// Document number
				result.i = value;
				break;
				
			case 'fp':
				// Fiscal sign
				result.fp = value;
				break;
				
			case 'n':
				// Operation type
				result.n = parseInt(value, 10);
				if (isNaN(result.n) || result.n < 1 || result.n > 4) {
					result.n = undefined;
				}
				break;
		}
	}
	
	// Validate that we got at least some useful data
	if (!result.amount && !result.dateTime && !result.fn) {
		return null;
	}
	
	return result;
}

/**
 * Parse date/time from format YYYYMMDDTHHMM to ISO string
 * Example: 20260316T1007 → 2026-03-16T10:07:00
 */
function parseDateTime(dateTimeStr: string): string | undefined {
	if (!dateTimeStr || dateTimeStr.length < 12) {
		return undefined;
	}
	
	try {
		// Format: YYYYMMDDTHHMM
		const year = dateTimeStr.substring(0, 4);
		const month = dateTimeStr.substring(4, 6);
		const day = dateTimeStr.substring(6, 8);
		const hour = dateTimeStr.substring(9, 11);
		const minute = dateTimeStr.substring(11, 13);
		
		const isoString = `${year}-${month}-${day}T${hour}:${minute}:00`;
		const date = new Date(isoString);
		
		if (isNaN(date.getTime())) {
			return undefined;
		}
		
		return date.toISOString();
	} catch (e) {
		return undefined;
	}
}

/**
 * Convert operation type number to text description
 */
export function getOperationTypeText(type: number): string {
	switch (type) {
		case 1: return 'Приход';
		case 2: return 'Возврат прихода';
		case 3: return 'Расход';
		case 4: return 'Возврат расхода';
		default: return 'Неизвестно';
	}
}

/**
 * Convert operation type to transaction type
 */
export function operationTypeToTransactionType(type: number): 'expense' | 'income' {
	// According to 54-FZ:
	// n=1 (Приход) - customer pays money = expense for customer
	// n=2 (Возврат прихода) - customer returns item = income back to customer
	// n=3 (Расход) - organization pays to customer = income for customer
	// n=4 (Возврат расхода) - return of payout = expense
	if (type === 1 || type === 4) {
		return 'expense';
	} else if (type === 2 || type === 3) {
		return 'income';
	}
	// Default to expense
	return 'expense';
}
