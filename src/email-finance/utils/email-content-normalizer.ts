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
			const hex = unfolded.slice(index + 1, index + 3);
			if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
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
	if (matches.length < 3) {
		return false;
	}

	const hasCommonQuotedPrintableMarkers = matches.some((match) => {
		const upper = match.toUpperCase();
		return upper === '=3D'
			|| upper === '=20'
			|| upper === '=09'
			|| upper === '=0A'
			|| upper === '=0D'
			|| upper.startsWith('=D0')
			|| upper.startsWith('=D1')
			|| upper.startsWith('=C2')
			|| upper.startsWith('=C3');
	});
	return hasCommonQuotedPrintableMarkers;
}
