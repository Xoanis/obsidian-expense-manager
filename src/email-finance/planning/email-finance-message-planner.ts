import type {
	FinanceReceiptProposalRequest,
	FinanceTextProposalRequest,
} from '../../services/finance-intake-service';
import type { PluginLogger } from '../../utils/plugin-debug-log';
import type { FinanceMailAttachment, FinanceMailMessage } from '../transport/finance-mail-provider';
import { decodeEmailTransferText, toSearchablePlainText } from '../utils/email-content-normalizer';
import {
	CompositeEmailFinanceMessageParser,
	collectEmailFinanceMessageDebugSignals,
	createDefaultEmailFinanceMessageParsers,
	type EmailFinanceParserAttempt,
	type EmailFinanceMessageParser,
} from '../parsers/email-finance-message-parsers';

export interface PlannedEmailFinanceTextUnit {
	kind: 'text';
	label: string;
	plannerSourceId?: string;
	remoteArtifactUrl?: string;
	remoteArtifactFileName?: string;
	remoteArtifactMimeType?: string;
	request: FinanceTextProposalRequest;
}

export interface PlannedEmailFinanceReceiptUnit {
	kind: 'receipt';
	label: string;
	plannerSourceId?: string;
	request: FinanceReceiptProposalRequest;
}

export type PlannedEmailFinanceUnit = PlannedEmailFinanceTextUnit | PlannedEmailFinanceReceiptUnit;

export interface EmailFinancePlanningResult {
	units: PlannedEmailFinanceUnit[];
	parserAttempts: EmailFinanceParserAttempt[];
	usedGenericFallback: boolean;
	attachmentUnitCount: number;
	textUnitCreated: boolean;
}

export class EmailFinanceMessagePlanner {
	private readonly parserChain: CompositeEmailFinanceMessageParser;
	private readonly logger?: PluginLogger;

	constructor(
		parsers: EmailFinanceMessageParser[] = createDefaultEmailFinanceMessageParsers(),
		logger?: PluginLogger,
	) {
		this.parserChain = new CompositeEmailFinanceMessageParser(parsers);
		this.logger = logger;
	}

	planMessage(message: FinanceMailMessage): PlannedEmailFinanceUnit[] {
		return this.planMessageDetailed(message).units;
	}

	planMessageDetailed(message: FinanceMailMessage): EmailFinancePlanningResult {
		const debugSignals = collectEmailFinanceMessageDebugSignals(message);
		this.logger?.info('Email finance planner started', {
			messageId: message.id,
			subject: message.subject,
			from: message.from,
			attachmentCount: message.attachments.length,
			attachmentNames: message.attachmentNames,
			textBodyLength: message.textBody?.length ?? 0,
			htmlBodyLength: message.htmlBody?.length ?? 0,
			textBodyPreviewLength: message.textBodyPreview?.length ?? 0,
			htmlBodyPreviewLength: message.htmlBodyPreview?.length ?? 0,
		});
		this.logger?.info('Email finance planner message signals', {
			messageId: message.id,
			subject: message.subject,
			from: message.from,
			debugSignals,
		});

		const units: PlannedEmailFinanceUnit[] = [];
		const parserAttempts = this.parserChain.parse(message);
		for (const attempt of parserAttempts) {
			this.logger?.info('Email finance parser attempt', {
				messageId: message.id,
				subject: message.subject,
				parserId: attempt.parserId,
				matched: attempt.matched,
				stop: attempt.stop,
				reason: attempt.reason,
				unitLabels: attempt.units.map((unit) => `${unit.kind}:${unit.label}`),
				diagnostics: attempt.diagnostics ?? null,
			});
			if (!attempt.matched || attempt.units.length === 0) {
				continue;
			}

			units.push(...attempt.units.map((unit) => ({
				...unit,
				plannerSourceId: attempt.parserId,
			})));
			if (attempt.stop) {
				const uniqueUnits = this.uniqueUnits(units);
				this.logger?.info('Email finance planner stopped after parser match', {
					messageId: message.id,
					subject: message.subject,
					parserId: attempt.parserId,
					unitCount: uniqueUnits.length,
				});
				return {
					units: uniqueUnits,
					parserAttempts,
					usedGenericFallback: false,
					attachmentUnitCount: 0,
					textUnitCreated: false,
				};
			}
		}

		const attachmentUnits = this.planAttachmentUnits(message);
		units.push(...attachmentUnits);

		const textUnit = this.planTextUnit(message);
		if (textUnit) {
			units.push(textUnit);
		}

		const uniqueUnits = this.uniqueUnits(units);
		this.logger?.info('Email finance planner fallback completed', {
			messageId: message.id,
			subject: message.subject,
			attachmentUnitCount: attachmentUnits.length,
			textUnitCreated: Boolean(textUnit),
			unitCount: uniqueUnits.length,
		});
		return {
			units: uniqueUnits,
			parserAttempts,
			usedGenericFallback: true,
			attachmentUnitCount: attachmentUnits.length,
			textUnitCreated: Boolean(textUnit),
		};
	}

	private planAttachmentUnits(message: FinanceMailMessage): PlannedEmailFinanceReceiptUnit[] {
		const units: PlannedEmailFinanceReceiptUnit[] = [];
		for (const attachment of message.attachments) {
			if (!attachment.contentBase64) {
				continue;
			}

			const mimeType = attachment.mimeType?.toLowerCase() ?? '';
			const fileName = attachment.fileName || 'attachment';
			const isImage = mimeType.startsWith('image/') || /\.(png|jpg|jpeg|webp|bmp)$/i.test(fileName);
			const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(fileName);
			if (!isImage && !isPdf) {
				continue;
			}

			units.push({
				kind: 'receipt',
				label: fileName,
				plannerSourceId: 'attachment',
				request: {
					bytes: this.decodeBase64(attachment.contentBase64),
					fileName,
					mimeType: attachment.mimeType,
					caption: this.buildAttachmentCaption(message, attachment),
					intent: 'neutral',
					source: 'email',
				},
			});
		}

		return units;
	}

	private planTextUnit(message: FinanceMailMessage): PlannedEmailFinanceTextUnit | null {
		const normalizedBody = this.normalizeBodyText(message);
		const htmlContext = this.buildHtmlContext(message);
		const subject = message.subject?.trim() ?? '';
		const parts = [
			subject ? `Subject: ${subject}` : '',
			htmlContext,
			normalizedBody,
		].filter((value) => value.trim().length > 0);
		if (parts.length === 0) {
			return null;
		}

		return {
			kind: 'text',
			label: subject || 'email-body',
			plannerSourceId: 'generic-text-body',
			request: {
				text: parts.join('\n\n'),
				intent: 'neutral',
				source: 'email',
			},
		};
	}

	private buildAttachmentCaption(
		message: FinanceMailMessage,
		attachment: FinanceMailAttachment,
	): string {
		const subject = message.subject?.trim() ?? '';
		const from = message.from?.trim() ?? '';
		const bodyPreview = this.normalizeBodyText(message).slice(0, 280);
		return [
			subject,
			from ? `From: ${from}` : '',
			this.buildHtmlContext(message),
			bodyPreview,
			attachment.fileName,
		].filter((value) => value.trim().length > 0).join(' | ');
	}

	private buildHtmlContext(message: FinanceMailMessage): string {
		const htmlBody = this.getDecodedHtmlBody(message);
		if (!htmlBody) {
			return '';
		}

		const lines: string[] = [];
		const links = this.extractHtmlLinks(htmlBody);
		if (links.length > 0) {
			lines.push('HTML links:');
			lines.push(...links.map((link) => `- ${link}`));
		}

		const inlineImageSources = this.extractHtmlImageSources(htmlBody);
		if (inlineImageSources.length > 0) {
			lines.push('HTML image sources:');
			lines.push(...inlineImageSources.map((src) => `- ${src}`));
		}

		return lines.join('\n');
	}

	private normalizeBodyText(message: FinanceMailMessage): string {
		const textBody = this.getDecodedTextBody(message);
		if (textBody) {
			return textBody;
		}

		const htmlBody = this.getDecodedHtmlBody(message);
		if (!htmlBody) {
			return decodeEmailTransferText(message.textBodyPreview?.trim() ?? '');
		}

		return toSearchablePlainText(htmlBody
			.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
				const label = this.stripHtmlTags(String(text)).trim();
				const normalizedHref = String(href).trim();
				if (!label) {
					return ` ${normalizedHref} `;
				}
				return ` ${label} (${normalizedHref}) `;
			}));
	}

	private extractHtmlLinks(html: string): string[] {
		const matches = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi);
		return this.unique(
			Array.from(matches, (match) => match[1]?.trim() ?? '')
				.filter((value) => value.length > 0),
		);
	}

	private extractHtmlImageSources(html: string): string[] {
		const matches = html.matchAll(/<img\b[^>]*src\s*=\s*["']([^"']+)["']/gi);
		return this.unique(
			Array.from(matches, (match) => match[1]?.trim() ?? '')
				.filter((value) => value.length > 0),
		);
	}

	private stripHtmlTags(value: string): string {
		return value.replace(/<[^>]+>/g, ' ');
	}

	private getDecodedTextBody(message: FinanceMailMessage): string {
		return decodeEmailTransferText(message.textBody?.trim() || message.textBodyPreview?.trim() || '');
	}

	private getDecodedHtmlBody(message: FinanceMailMessage): string {
		return decodeEmailTransferText(message.htmlBody?.trim() || message.htmlBodyPreview?.trim() || '');
	}

	private unique(values: string[]): string[] {
		return Array.from(new Set(values));
	}

	private uniqueUnits(units: PlannedEmailFinanceUnit[]): PlannedEmailFinanceUnit[] {
		const seen = new Set<string>();
		return units.filter((unit) => {
			const key = unit.kind === 'text'
				? `text:${unit.label}:${unit.remoteArtifactUrl ?? ''}:${unit.request.text}`
				: `receipt:${unit.label}:${unit.request.fileName}:${unit.request.mimeType ?? ''}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	private decodeBase64(value: string): ArrayBuffer {
		if (typeof Buffer !== 'undefined') {
			const buffer = Buffer.from(value, 'base64');
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		}

		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes.buffer;
	}
}
