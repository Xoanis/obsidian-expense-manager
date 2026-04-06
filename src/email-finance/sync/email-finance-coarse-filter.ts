import type { EmailFinanceCoarseFilterField, EmailFinanceCoarseFilterRule } from '../../settings';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';

export interface EmailFinanceCoarseFilterResult {
	passed: boolean;
	includeRuleIds: string[];
	excludeRuleIds: string[];
	reason: string;
}

export class EmailFinanceCoarseFilter {
	evaluate(
		message: FinanceMailMessage,
		rules: EmailFinanceCoarseFilterRule[],
	): EmailFinanceCoarseFilterResult {
		const enabledRules = rules.filter((rule) => rule.enabled && rule.pattern.trim().length > 0);
		const includeRuleIds: string[] = [];
		const excludeRuleIds: string[] = [];

		for (const rule of enabledRules) {
			if (!this.matches(message, rule)) {
				continue;
			}

			if (rule.action === 'exclude') {
				excludeRuleIds.push(rule.id);
			} else {
				includeRuleIds.push(rule.id);
			}
		}

		if (excludeRuleIds.length > 0) {
			return {
				passed: false,
				includeRuleIds,
				excludeRuleIds,
				reason: 'matched-exclude-rule',
			};
		}

		const hasIncludeRules = enabledRules.some((rule) => rule.action === 'include');
		if (hasIncludeRules && includeRuleIds.length === 0) {
			return {
				passed: false,
				includeRuleIds,
				excludeRuleIds,
				reason: 'no-include-match',
			};
		}

		return {
			passed: true,
			includeRuleIds,
			excludeRuleIds,
			reason: includeRuleIds.length > 0 ? 'matched-include-rule' : 'no-include-rules-configured',
		};
	}

	private matches(
		message: FinanceMailMessage,
		rule: EmailFinanceCoarseFilterRule,
	): boolean {
		const haystacks = this.readFieldValues(message, rule.field);
		if (haystacks.length === 0) {
			return false;
		}

		if (rule.mode === 'regex') {
			try {
				const regex = new RegExp(rule.pattern, 'i');
				return haystacks.some((value) => regex.test(value));
			} catch {
				return false;
			}
		}

		const pattern = rule.pattern.toLocaleLowerCase();
		return haystacks.some((value) => value.toLocaleLowerCase().includes(pattern));
	}

	private readFieldValues(
		message: FinanceMailMessage,
		field: EmailFinanceCoarseFilterField,
	): string[] {
		const bodyValues = [message.textBodyPreview ?? '', message.htmlBodyPreview ?? '']
			.filter((value) => value.trim().length > 0);
		const attachmentValues = [...message.attachmentNames, ...message.attachments.map((attachment) => attachment.fileName)]
			.filter((value) => value.trim().length > 0);

		switch (field) {
			case 'from':
				return message.from ? [message.from] : [];
			case 'subject':
				return message.subject ? [message.subject] : [];
			case 'body':
				return bodyValues;
			case 'attachmentName':
				return attachmentValues;
			case 'any':
				return [
					...(message.from ? [message.from] : []),
					...(message.subject ? [message.subject] : []),
					...bodyValues,
					...attachmentValues,
				];
			default:
				return [];
		}
	}
}
