import type { EmailFinanceProviderKind } from '../../settings';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';

export function isEmailFinanceRebuildProviderCompatible(
	noteProvider: string | undefined,
	activeProviderKind: EmailFinanceProviderKind,
): boolean {
	const normalizedNoteProvider = noteProvider?.trim();
	if (!normalizedNoteProvider) {
		return true;
	}
	if (normalizedNoteProvider === activeProviderKind) {
		return true;
	}

	return normalizedNoteProvider === 'imap' && activeProviderKind === 'email-provider';
}

export function resolveRebuiltEmailMessageId(
	message: Pick<FinanceMailMessage, 'id'>,
	fallbackMessageId: string,
): string {
	const canonicalMessageId = message.id?.trim();
	return canonicalMessageId || fallbackMessageId;
}
