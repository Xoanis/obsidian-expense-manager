export function decodeEmailTransferText(value: string): string {
	if (!value || typeof value !== 'string') {
		return '';
	}

	const normalized = value.replace(/\r\n/g, '\n');
	if (!looksLikeQuotedPrintable(normalized)) {
		return normalized;
	}

	const unfolded = normalized.replace(/=\n/g, '');
	const bytes: number[] = [];
	for (let index = 0; index < unfolded.length; index += 1) {
		const current = unfolded[index];
		if (current === '=' && index + 2 < unfolded.length) {
			const hex = unfolded.slice(index + 1, index + 3).toUpperCase();
			if (shouldDecodeQuotedPrintableHex(unfolded, index, hex)) {
				bytes.push(parseInt(hex, 16));
				index += 2;
				continue;
			}
		}

		bytes.push(unfolded.charCodeAt(index) & 0xff);
	}

	try {
		if (typeof Buffer !== 'undefined') {
			return Buffer.from(bytes).toString('utf8');
		}
		if (typeof TextDecoder !== 'undefined') {
			return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
		}
	} catch {
		return normalized;
	}

	return normalized;
}

export function decodeCommonHtmlEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
			try {
				return String.fromCodePoint(parseInt(hex, 16));
			} catch {
				return _match;
			}
		})
		.replace(/&#([0-9]+);/g, (_match, decimal) => {
			try {
				return String.fromCodePoint(parseInt(decimal, 10));
			} catch {
				return _match;
			}
		})
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, '\'')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>');
}

function looksLikeQuotedPrintable(value: string): boolean {
	if (/=\n/.test(value) || /=\r\n/.test(value)) {
		return true;
	}

	const matches = value.match(/=[0-9A-Fa-f]{2}/g) ?? [];
	return matches.some((match) => isCommonQuotedPrintableHex(match.slice(1).toUpperCase()));
}

function shouldDecodeQuotedPrintableHex(value: string, index: number, hex: string): boolean {
	if (!/^[0-9A-F]{2}$/.test(hex)) {
		return false;
	}

	if (isCommonQuotedPrintableHex(hex)) {
		return true;
	}

	return hasAdjacentEncodedOctet(value, index);
}

function isCommonQuotedPrintableHex(hex: string): boolean {
	return hex === '3D'
		|| hex === '20'
		|| hex === '09'
		|| hex === '0A'
		|| hex === '0D'
		|| hex.startsWith('D0')
		|| hex.startsWith('D1')
		|| hex.startsWith('C2')
		|| hex.startsWith('C3');
}

function hasAdjacentEncodedOctet(value: string, index: number): boolean {
	const previousTokenStart = index - 3;
	if (previousTokenStart >= 0) {
		const previousToken = value.slice(previousTokenStart, previousTokenStart + 3);
		if (/^=[0-9A-Fa-f]{2}$/.test(previousToken)) {
			return true;
		}
	}

	const nextTokenStart = index + 3;
	if (nextTokenStart + 2 < value.length) {
		const nextToken = value.slice(nextTokenStart, nextTokenStart + 3);
		if (/^=[0-9A-Fa-f]{2}$/.test(nextToken)) {
			return true;
		}
	}

	return false;
}
