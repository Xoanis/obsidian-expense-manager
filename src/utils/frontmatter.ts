import { normalizeTransactionStatus, TransactionData, TransactionDetail } from '../types';

/**
 * Generate YAML frontmatter from transaction data
 */
export function generateFrontmatter(data: TransactionData): string {
	const frontmatter: Record<string, unknown> = {
		type: data.type,
		status: normalizeTransactionStatus(data.status),
		amount: data.amount,
		currency: data.currency,
		dateTime: data.dateTime,
		description: data.description,
		area: data.area,
		project: data.project,
		tags: data.tags,
		category: data.category || data.tags[0] || 'uncategorized',
		source: data.source,
		artifact: data.artifact,
	};

	if (data.emailMessageId) {
		frontmatter.email_msg_id = data.emailMessageId;
	}
	if (data.emailProvider) {
		frontmatter.email_provider = data.emailProvider;
	}
	if (data.emailMailboxScope) {
		frontmatter.email_mailbox_scope = data.emailMailboxScope;
	}
	if (data.duplicateOf) {
		frontmatter.duplicate_of = data.duplicateOf;
	}

	// Add fiscal document fields if available
	if (data.fn) {
		frontmatter.fn = data.fn;
	}
	if (data.fd) {
		frontmatter.fd = data.fd;
	}
	if (data.fp) {
		frontmatter.fp = data.fp;
	}
	if (data.receiptOperationType) {
		frontmatter.receiptOperationType = data.receiptOperationType;
	}
	if (data.proverkaCheka === true) {
		frontmatter.ProverkaCheka = true;
	}

	// Convert to YAML manually to avoid external dependencies
	let yaml = '---\n';
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined || value === null) {
			continue;
		}
		
		if (Array.isArray(value)) {
			yaml += `${key}: ${JSON.stringify(value)}\n`;
		} else if (typeof value === 'string' && isYamlDateLikeField(key)) {
			yaml += `${key}: ${value}\n`;
		} else if (typeof value === 'string') {
			// Escape quotes in strings
			const escaped = value.replace(/"/g, '\\"');
			yaml += `${key}: "${escaped}"\n`;
		} else {
			yaml += `${key}: ${value}\n`;
		}
	}
	yaml += '---\n\n';

	return yaml;
}

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseYamlFrontmatter(content: string): Record<string, unknown> | null {
	// Check if content starts with frontmatter delimiter
	if (!content.startsWith('---\n')) {
		return null;
	}

	const endIndex = content.indexOf('\n---\n', 4);
	if (endIndex === -1) {
		return null;
	}

	const frontmatterText = content.substring(4, endIndex);
	const parsed: Record<string, unknown> = {};

	// Simple YAML parser for our specific format
	const lines = frontmatterText.split('\n');
	for (const line of lines) {
		if (!line.trim() || line.startsWith('#')) {
			continue;
		}

		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) {
			continue;
		}

		const key = line.substring(0, colonIndex).trim();
		const value = line.substring(colonIndex + 1).trim();

		// Parse value based on type
		if (value.startsWith('[') && value.endsWith(']')) {
			// Array - parse JSON
			try {
				parsed[key] = JSON.parse(value);
			} catch {
				parsed[key] = [];
			}
		} else if (value.startsWith('"') && value.endsWith('"')) {
			// String with quotes
			parsed[key] = value.slice(1, -1).replace(/\\"/g, '"');
		} else if (value === 'true' || value === 'false') {
			// Boolean
			parsed[key] = value === 'true';
		} else if (!isNaN(Number(value))) {
			// Number
			parsed[key] = Number(value);
		} else {
			// Plain string
			parsed[key] = value;
		}
	}

	return parsed;
}

export function parseFrontmatter(content: string): Partial<TransactionData> | null {
	return parseYamlFrontmatter(content) as Partial<TransactionData> | null;
}

export function parseSourceContextFromContent(content: string): string | undefined {
	const match = content.match(/## Source Context\s*\n([\s\S]*?)(?=\n## |\s*$)/);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

/**
 * Extract transaction details from content body
 */
export function parseDetailsFromContent(content: string): TransactionDetail[] | undefined {
	// Look for items section in the content
	const itemsMatch = content.match(/## Items\s*\n([\s\S]*?)(?=\n##|\Z)/);
	if (!itemsMatch) {
		return undefined;
	}

	const itemsText = itemsMatch[1];
	const details: TransactionDetail[] = [];

	// Parse each line item (format: "- Item name: price")
	const lines = itemsText.split('\n');
	for (const line of lines) {
		const itemMatch = line.match(/^-?\s*(.+?):\s*([\d.]+)\s*(?:x\s*([\d.]+))?\s*(?:=\s*([\d.]+))?/i);
		if (itemMatch) {
			const name = itemMatch[1].trim();
			const price = parseFloat(itemMatch[2]) || 0;
			const quantity = parseFloat(itemMatch[3]) || 1;
			const total = parseFloat(itemMatch[4]) || (price * quantity);

			details.push({ name, quantity, price, total });
		}
	}

	return details.length > 0 ? details : undefined;
}

/**
 * Generate markdown content body from transaction data
 */
export function generateContentBody(data: TransactionData): string {
	const lines: string[] = [];

	// Add details if available
	if (data.details && data.details.length > 0) {
		lines.push('## Items', '');
		for (const detail of data.details) {
			const lineTotal = (detail.price * detail.quantity).toFixed(2);
			lines.push(`- ${detail.name}: ${detail.price.toFixed(2)} x ${detail.quantity} = ${lineTotal}`);
		}
		lines.push('');
	}

	if (data.artifact) {
		lines.push('## Artifact', '', data.artifact, '');
	}

	if (data.sourceContext?.trim()) {
		lines.push('## Source Context', '', data.sourceContext.trim(), '');
	}

	return lines.length > 0 ? `${lines.join('\n').trim()}\n` : '';
}

export function upsertItemsSection(content: string, details: TransactionDetail[]): string {
	if (!details.length) {
		return content;
	}

	const renderedSection = renderItemsSection(details);
	const itemsSectionPattern = /\n## Items\s*\n[\s\S]*?(?=\n## [^\n]+\n|\s*$)/;
	if (itemsSectionPattern.test(content)) {
		const updated = content.replace(itemsSectionPattern, `\n\n${renderedSection}`);
		return updated.endsWith('\n') ? updated : `${updated}\n`;
	}

	const insertionIndex = findSectionInsertionIndex(content);
	const before = content.slice(0, insertionIndex).replace(/\s*$/, '');
	const after = content.slice(insertionIndex).replace(/^\s*/, '');
	const nextContent = after
		? `${before}\n\n${renderedSection}\n\n${after}`
		: `${before}\n\n${renderedSection}\n`;

	return nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
}

/**
 * Format ISO date string to readable format
 */
export function formatDateTime(isoString: string, format = 'YYYY-MM-DD HH:mm'): string {
	const date = new Date(isoString);
	
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');

	return format
		.replace('YYYY', String(year))
		.replace('MM', month)
		.replace('DD', day)
		.replace('HH', hours)
		.replace('mm', minutes);
}

/**
 * Generate filename from transaction data
 */
export function generateFilename(data: Pick<TransactionData, 'dateTime' | 'type' | 'amount' | 'description'>): string {
	const date = new Date(data.dateTime);
	const dateStr = formatLocalDate(date);
	const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-mm-ss
	const typeShort = data.type === 'expense' ? 'exp' : 'inc';
	const amountStr = data.amount.toFixed(0);
	const descriptionShort = data.description
		.substring(0, 20)
		.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s-]/g, '')
		.replace(/\s+/g, '-')
		.toLowerCase();

	return `${dateStr}-${timeStr}-${typeShort}-${amountStr}-${descriptionShort}.md`;
}

function isYamlDateLikeField(key: string): boolean {
	return key === 'dateTime'
		|| key === 'generatedAt'
		|| key === 'periodStart'
		|| key === 'periodEnd'
		|| key === 'created';
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function renderItemsSection(details: TransactionDetail[]): string {
	const lines = ['## Items', ''];
	for (const detail of details) {
		const lineTotal = (detail.price * detail.quantity).toFixed(2);
		lines.push(`- ${detail.name}: ${detail.price.toFixed(2)} x ${detail.quantity} = ${lineTotal}`);
	}

	return lines.join('\n');
}

function findSectionInsertionIndex(content: string): number {
	const sectionAnchors = ['\n## Artifact', '\n## Source Context'];
	const positions = sectionAnchors
		.map((anchor) => content.indexOf(anchor))
		.filter((index) => index >= 0);

	if (positions.length > 0) {
		return Math.min(...positions);
	}

	return content.length;
}
