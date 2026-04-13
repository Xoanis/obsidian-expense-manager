export function parseEmailProviderChannelSelection(value: string | undefined): string[] {
	if (!value?.trim()) {
		return [];
	}

	const ids: string[] = [];
	const seen = new Set<string>();
	for (const token of value.split(/[\r\n,;]+/)) {
		const normalized = token.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		ids.push(normalized);
	}

	return ids;
}

export function normalizeEmailProviderChannelIds(channelIds: string[]): string[] {
	return Array.from(new Set(
		channelIds
			.map((channelId) => channelId.trim())
			.filter(Boolean),
	)).sort((left, right) => left.localeCompare(right));
}

export function buildEmailProviderChannelSelectionKey(channelIds: string[]): string {
	const normalizedChannelIds = normalizeEmailProviderChannelIds(channelIds);
	if (normalizedChannelIds.length === 0) {
		throw new Error('At least one email-provider channel id is required.');
	}
	if (normalizedChannelIds.length === 1) {
		return normalizedChannelIds[0];
	}

	return `selection:${normalizedChannelIds.map((channelId) => encodeURIComponent(channelId)).join(',')}`;
}
