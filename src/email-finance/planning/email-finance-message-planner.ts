import type {
	FinanceReceiptProposalRequest,
	FinanceTextProposalRequest,
} from '../../services/finance-intake-service';
import type { FinanceMailAttachment, FinanceMailMessage } from '../transport/finance-mail-provider';
import { decodeCommonHtmlEntities, decodeEmailTransferText } from '../utils/email-content-normalizer';
import {
	CompositeEmailFinanceMessageParser,
	createDefaultEmailFinanceMessageParsers,
	type EmailFinanceMessageParser,
} from '../parsers/email-finance-message-parsers';

export interface PlannedEmailFinanceTextUnit {
	kind: 'text';
	label: string;
	plannerSourceId?: string;
	request: FinanceTextProposalRequest;
}

export interface PlannedEmailFinanceReceiptUnit {
	kind: 'receipt';
	label: string;
	plannerSourceId?: string;
	request: FinanceReceiptProposalRequest;
}

export type PlannedEmailFinanceUnit = PlannedEmailFinanceTextUnit | PlannedEmailFinanceReceiptUnit;

export class EmailFinanceMessagePlanner {
	private readonly parserChain: CompositeEmailFinanceMessageParser;

	constructor(parsers: EmailFinanceMessageParser[] = createDefaultEmailFinanceMessageParsers()) {
		this.parserChain = new CompositeEmailFinanceMessageParser(parsers);
	}

	planMessage(message: FinanceMailMessage): PlannedEmailFinanceUnit[] {
		const units: PlannedEmailFinanceUnit[] = [];
		const parserResults = this.parserChain.parse(message);
		for (const result of parserResults) {
			units.push(...result.units.map((unit) => ({
				...unit,
				plannerSourceId: result.parserId,
			})));
			if (result.stop) {
				return this.uniqueUnits(units);
			}
		}

		const attachmentUnits = this.planAttachmentUnits(message);
		units.push(...attachmentUnits);

		const textUnit = this.planTextUnit(message);
		if (textUnit) {
			units.push(textUnit);
		}

		return this.uniqueUnits(units);
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

		return decodeCommonHtmlEntities(htmlBody
			.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
				const label = this.stripHtmlTags(String(text)).trim();
				const normalizedHref = String(href).trim();
				if (!label) {
					return ` ${normalizedHref} `;
				}
				return ` ${label} (${normalizedHref}) `;
			})
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, '\'')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/\s+/g, ' ')
			.trim());
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
				? `text:${unit.label}:${unit.request.text}`
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
