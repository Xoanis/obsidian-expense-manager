export function parseBudgetInput(rawText: string): number | null | undefined {
	const trimmed = rawText.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed === '-') {
		return null;
	}

	const normalized = trimmed.replace(',', '.');
	const value = Number(normalized);
	if (!Number.isFinite(value) || value < 0) {
		return undefined;
	}

	return value;
}
