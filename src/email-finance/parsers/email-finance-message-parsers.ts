import type {
	FinanceTextProposalRequest,
} from '../../services/finance-intake-service';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';
import type { PlannedEmailFinanceTextUnit, PlannedEmailFinanceUnit } from '../planning/email-finance-message-planner';
import { decodeCommonHtmlEntities, decodeEmailTransferText } from '../utils/email-content-normalizer';

export interface EmailFinanceParserResult {
	units: PlannedEmailFinanceUnit[];
	stop: boolean;
	parserId: string;
}

export interface EmailFinanceMessageParser {
	readonly id: string;
	parse(message: FinanceMailMessage): EmailFinanceParserResult | null;
}

export class CompositeEmailFinanceMessageParser {
	constructor(private readonly parsers: EmailFinanceMessageParser[]) {}

	parse(message: FinanceMailMessage): EmailFinanceParserResult[] {
		const results: EmailFinanceParserResult[] = [];
		for (const parser of this.parsers) {
			const result = parser.parse(message);
			if (!result || result.units.length === 0) {
				continue;
			}

			results.push(result);
			if (result.stop) {
				break;
			}
		}
		return results;
	}
}

export function createDefaultEmailFinanceMessageParsers(): EmailFinanceMessageParser[] {
	return [
		new FiscalReceiptFieldsEmailParser(),
		new YandexCheckReceiptEmailParser(),
		new OzonReceiptEmailParser(),
		new ReceiptLinkEmailParser(),
		new ReceiptSummaryEmailParser(),
	];
}

class YandexCheckReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'yandex-check-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserResult | null {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractCandidateLinks(normalizedBody);
		const receiptLinks = links.filter((link) => /check\.yandex\.ru/i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeYandexReceipt = receiptLinks.length > 0
			|| /check\.yandex\.ru/i.test(senderDomain)
			|| (/яндекс/i.test(normalizedBody) && /кассовый чек|ссылка на ваш чек/i.test(normalizedBody));
		if (!looksLikeYandexReceipt) {
			return null;
		}

		const receiptFields = extractFiscalReceiptFields(normalizedBody);
		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const merchant = extractReceiptMerchant(normalizedBody, from);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const units: PlannedEmailFinanceUnit[] = [];

		if (receiptFields) {
			units.push({
				kind: 'text',
				label: 'yandex-fiscal-receipt-fields',
				request: {
					text: buildRawReceiptQrPayload(receiptFields),
					intent: 'neutral',
					source: 'email',
				},
			});
		}

		units.push({
			kind: 'text',
			label: 'yandex-check-receipt-summary',
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Vendor parser: Yandex receipt email',
					'- Receipt provider: check.yandex.ru',
					merchant ? `- Detected merchant: ${merchant}` : '',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					receiptFields?.fn ? `- Fiscal FN: ${receiptFields.fn}` : '',
					receiptFields?.i ? `- Fiscal FD number: ${receiptFields.i}` : '',
					receiptFields?.fp ? `- Fiscal sign: ${receiptFields.fp}` : '',
					receiptFields?.n ? `- Fiscal operation type: ${mapOperationTypeToSummary(receiptFields.n)}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		});

		return {
			parserId: this.id,
			units,
			stop: false,
		};
	}
}

class OzonReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'ozon-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserResult | null {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractCandidateLinks(normalizedBody);
		const receiptLinks = links.filter((link) => /ozon\.ru\/my\/e-check\//i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeOzonReceipt = receiptLinks.length > 0
			|| /(?:^|\.)ozon\.ru$/i.test(senderDomain)
			|| /sender\.ozon\.ru/i.test(senderDomain)
			|| (/ozon/i.test(normalizedBody) && /чек|e-check|receipt/i.test(normalizedBody));
		if (!looksLikeOzonReceipt) {
			return null;
		}

		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const units: PlannedEmailFinanceUnit[] = [{
			kind: 'text',
			label: 'ozon-receipt-summary',
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Vendor parser: Ozon receipt email',
					'- Receipt provider: Ozon',
					'- Merchant: Ozon',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					'Parser hint: Ozon often sends an email that points to an electronic receipt page. Treat receipt links and receipt excerpt as finance evidence even when the full fiscal fields are not visible in the email body.',
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		}];

		return {
			parserId: this.id,
			units,
			stop: false,
		};
	}
}

class ReceiptLinkEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-link';

	parse(message: FinanceMailMessage): EmailFinanceParserResult | null {
		const normalizedBody = normalizeMessageText(message);
		const links = extractCandidateLinks(normalizedBody);
		const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, message.subject ?? ''));
		if (receiptLinks.length === 0) {
			return null;
		}

		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const unit: PlannedEmailFinanceTextUnit = {
			kind: 'text',
			label: 'receipt-link',
			request: {
				text: [
					message.subject?.trim() ? `Subject: ${message.subject.trim()}` : '',
					message.from?.trim() ? `From: ${message.from.trim()}` : '',
					'Receipt links:',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `\nReceipt-related body excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			} as FinanceTextProposalRequest,
		};

		return {
			parserId: this.id,
			units: [unit],
			stop: false,
		};
	}
}

class FiscalReceiptFieldsEmailParser implements EmailFinanceMessageParser {
	readonly id = 'fiscal-receipt-fields';

	parse(message: FinanceMailMessage): EmailFinanceParserResult | null {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return null;
		}

		const receiptFields = extractFiscalReceiptFields(normalizedBody);
		if (!receiptFields) {
			return null;
		}

		const qrPayload = buildRawReceiptQrPayload(receiptFields);
		if (!qrPayload) {
			return null;
		}

		const unit: PlannedEmailFinanceTextUnit = {
			kind: 'text',
			label: 'fiscal-receipt-fields',
			request: ({
				text: qrPayload,
				intent: 'neutral',
				source: 'email',
			} as FinanceTextProposalRequest),
		};

		return {
			parserId: this.id,
			units: [unit],
			stop: true,
		};
	}
}

class ReceiptSummaryEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-summary';

	parse(message: FinanceMailMessage): EmailFinanceParserResult | null {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return null;
		}

		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractCandidateLinks(normalizedBody);
		const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, subject));
		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const merchant = extractReceiptMerchant(normalizedBody, from);
		const operationType = extractReceiptOperationType(normalizedBody);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);

		if (!looksLikeReceiptLikeMessage(subject, normalizedBody, {
			receiptLinks,
			amount,
			dateTime,
			merchant,
			focusedExcerpt,
		})) {
			return null;
		}

		const unit: PlannedEmailFinanceTextUnit = {
			kind: 'text',
			label: 'receipt-summary',
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Email parser summary:',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					merchant ? `- Detected merchant: ${merchant}` : '',
					operationType ? `- Detected fiscal operation type: ${mapOperationTypeToSummary(operationType)}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		};

		return {
			parserId: this.id,
			units: [unit],
			stop: false,
		};
	}
}

interface ExtractedFiscalReceiptFields {
	dateTime: string;
	amount: string;
	fn: string;
	i: string;
	fp: string;
	n: '1' | '2' | '3' | '4';
}

export function buildRawReceiptQrPayload(fields: ExtractedFiscalReceiptFields): string {
	return `t=${fields.dateTime}&s=${fields.amount}&fn=${fields.fn}&i=${fields.i}&fp=${fields.fp}&n=${fields.n}`;
}

export function extractFiscalReceiptFields(value: string): ExtractedFiscalReceiptFields | null {
	if (!value || typeof value !== 'string') {
		return null;
	}

	const normalized = value
		.replace(/&nbsp;/gi, ' ')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, '\'')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) {
		return null;
	}

	const fn = matchFirst(normalized, [
		/серийный номер фн\s*(\d{10,})/i,
		/\bфн\s*(\d{10,})/i,
		/\bfn\s*[=:]\s*(\d{10,})/i,
	]);
	const documentNumber = matchFirst(normalized, [
		/\bфд(?: в смене)?\s*(\d{1,})/i,
		/номер фд(?: в смене)?\s*(\d{1,})/i,
		/\b(?:fd|i)\s*[=:]\s*(\d{1,})/i,
	]);
	const fiscalSign = matchFirst(normalized, [
		/фпд\s*(\d{6,})/i,
		/фп\s*(\d{6,})/i,
		/\bfp\s*[=:]\s*(\d{6,})/i,
	]);
	const amount = extractReceiptAmount(normalized);
	const dateTime = extractReceiptDateTime(normalized);
	const operationType = extractReceiptOperationType(normalized);

	if (!fn || !documentNumber || !fiscalSign || !amount || !dateTime || !operationType) {
		return null;
	}

	return {
		dateTime,
		amount,
		fn,
		i: documentNumber,
		fp: fiscalSign,
		n: operationType,
	};
}

function looksLikeReceiptLink(link: string, body: string, subject: string): boolean {
	const normalizedLink = link.toLowerCase();
	const normalizedContext = `${subject}\n${body}`.toLowerCase();
	const hasReceiptKeyword = /чек|кассов|квитан|receipt|e-check|echeck|order receipt/.test(normalizedContext);
	return (
		/check\.yandex\.ru/.test(normalizedLink)
		|| /ozon\.ru\/my\/e-check\//.test(normalizedLink)
		|| /\/(?:receipt|e-check|echeck|check|cheque)\b/.test(normalizedLink)
		|| (hasReceiptKeyword && /ofd|receipt|check|cheque|kkt|taxcom|platformaofd/.test(normalizedLink))
	);
}

function looksLikeReceiptLikeMessage(
	subject: string,
	body: string,
	signals: {
		receiptLinks: string[];
		amount: string | null;
		dateTime: string | null;
		merchant: string | null;
		focusedExcerpt: string;
	},
): boolean {
	const normalizedContext = `${subject}\n${body}`.toLowerCase();
	const hasReceiptKeyword = /чек|кассов|квитан|оплат|платеж|покупк|заказ|списани|receipt|payment|paid|order|invoice|total/.test(normalizedContext);
	const detectedSignalCount = [
		signals.receiptLinks.length > 0,
		Boolean(signals.amount),
		Boolean(signals.dateTime),
		Boolean(signals.merchant),
		signals.focusedExcerpt.trim().length > 80,
	].filter(Boolean).length;
	return hasReceiptKeyword && detectedSignalCount >= 2;
}

function buildReceiptFocusedExcerpt(value: string, links: string[]): string {
	const withoutHtml = decodeCommonHtmlEntities(
		value
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	)
		.replace(/\s+/g, ' ')
		.trim();
	if (!withoutHtml) {
		return '';
	}

	const interesting = withoutHtml
		.split(/(?<=[.!?])\s+/)
		.filter((chunk) => {
			const normalized = chunk.toLowerCase();
			return /чек|кассов|квитан|итого|сумм|оплат|товар|заказ|receipt|total|amount|order/.test(normalized)
				|| links.some((link) => normalized.includes(link.toLowerCase()));
		})
		.join('\n');

	const result = interesting || withoutHtml.slice(0, 1800);
	return result.slice(0, 1800);
}

function extractReceiptAmount(value: string): string | null {
	const candidates = [
		/итого\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сколько\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/безналичными\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/(?:сумма(?:\s+к\s+оплате)?|к\s+оплате|оплачено|total|amount)\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/\bs\s*[=:]\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
	];
	for (const pattern of candidates) {
		const matched = value.match(pattern)?.[1];
		if (!matched) {
			continue;
		}

		const normalized = matched.replace(/[\s\u00A0]+/g, '').replace(',', '.');
		const parsed = Number(normalized);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed.toFixed(2);
		}
	}

	return null;
}

function extractReceiptDateTime(value: string): string | null {
	const explicitQrDate = value.match(/\bt\s*[=:]\s*(\d{8}T\d{4})/i)?.[1];
	if (explicitQrDate) {
		return explicitQrDate;
	}

	const russianDate = value.match(/когда\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s+(\d{2}):(\d{2})/i);
	if (russianDate) {
		const [, day, monthName, year, hour, minute] = russianDate;
		const month = mapRussianMonth(monthName);
		if (month) {
			return `${year}${month}${pad2(day)}T${hour}${minute}`;
		}
	}

	const dottedDate = value.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s+(\d{2}):(\d{2})\b/);
	if (dottedDate) {
		const [, day, month, year, hour, minute] = dottedDate;
		return `${year}${pad2(month)}${pad2(day)}T${hour}${minute}`;
	}

	const isoLikeDate = value.match(/\b(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})\b/i);
	if (isoLikeDate) {
		const [, year, month, day, hour, minute] = isoLikeDate;
		return `${year}${month}${day}T${hour}${minute}`;
	}

	return null;
}

function extractReceiptMerchant(value: string, from: string): string | null {
	const normalized = value.replace(/\s+/g, ' ').trim();
	const candidates = [
		normalized.match(/кассовый чек\s*\/\s*(?:приход|расход)\s+(.+?)(?=\s+(?:когда|дата|время|сумма|сколько|товары|итого|безналичными|инн|адрес|место|налогообложение)\b|$)/i)?.[1],
		normalized.match(/(?:продавец|поставщик|merchant|seller|получатель)\s*[:=]?\s*(.+?)(?=\s+(?:инн|кпп|итого|сумма|дата|время|чек|квитанц)\b|$)/i)?.[1],
		normalized.match(/\b((?:ооо|оао|зао|пао|ao|llc|ип)\s+[«"']?[^«"']{2,80}?[»"']?)(?=\s+(?:инн|кпп|итого|сумма|дата|время|чек|квитанц)\b|$)/i)?.[1],
	];
	for (const candidate of candidates) {
		const cleaned = cleanupMerchant(candidate);
		if (cleaned) {
			return cleaned;
		}
	}

	if (from) {
		const emailMatch = from.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1];
		if (emailMatch) {
			const domain = emailMatch.split('@')[1] ?? '';
			const host = domain.split('.').slice(0, -1).join('.');
			const cleanedHost = host.replace(/[-_]+/g, ' ').trim();
			if (cleanedHost && !/noreply|no reply|support|mail|robot|notify/i.test(cleanedHost)) {
				return cleanedHost;
			}
		}
	}

	return null;
}

function extractReceiptOperationType(value: string): '1' | '2' | '3' | '4' | null {
	if (/возврат\s+прихода/i.test(value)) {
		return '2';
	}
	if (/возврат\s+расхода/i.test(value)) {
		return '4';
	}
	if (/кассовый чек\s*\/\s*расход/i.test(value) || /\bрасход\b/i.test(value)) {
		return '3';
	}
	if (/кассовый чек\s*\/\s*приход/i.test(value) || /\bприход\b/i.test(value)) {
		return '1';
	}
	return null;
}

function mapOperationTypeToSummary(value: '1' | '2' | '3' | '4'): string {
	switch (value) {
		case '1':
			return 'sale / incoming receipt';
		case '2':
			return 'sale return';
		case '3':
			return 'expense / outgoing receipt';
		case '4':
			return 'expense return';
		default:
			return value;
	}
}

function matchFirst(value: string, patterns: RegExp[]): string | null {
	for (const pattern of patterns) {
		const matched = value.match(pattern)?.[1]?.trim();
		if (matched) {
			return matched;
		}
	}
	return null;
}

function pad2(value: string): string {
	return value.padStart(2, '0');
}

function cleanupMerchant(value: string | undefined): string | null {
	if (!value) {
		return null;
	}

	const cleaned = value
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'«»]+|[\s"'«».,:;()\-]+$/g, '')
		.trim();
	if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
		return null;
	}

	if (/^(когда|дата|время|сумма|сколько|товары|итого|безналичными|инн|адрес|место)$/i.test(cleaned)) {
		return null;
	}

	return cleaned;
}

function extractSenderDomain(from: string): string {
	const emailMatch = from.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1];
	return emailMatch?.split('@')[1]?.toLowerCase() ?? '';
}

function normalizeMessageText(message: FinanceMailMessage): string {
	return [
		decodeEmailTransferText(message.subject?.trim() ?? ''),
		decodeEmailTransferText(message.textBody?.trim() ?? ''),
		decodeEmailTransferText(message.htmlBody?.trim() ?? ''),
		decodeEmailTransferText(message.textBodyPreview?.trim() ?? ''),
		decodeEmailTransferText(message.htmlBodyPreview?.trim() ?? ''),
	].filter(Boolean).join('\n\n');
}

function extractCandidateLinks(value: string): string[] {
	const decoded = decodeCommonHtmlEntities(value);
	const normalizedHref = decoded.replace(/href\s*=\s*3D/gi, 'href=');
	const matches = normalizedHref.matchAll(/https?:\/\/[^\s"'<>]+/gi);
	return Array.from(new Set(Array.from(matches, (match) => match[0].trim())));
}

function mapRussianMonth(value: string): string | null {
	const normalized = value.toLocaleLowerCase('ru-RU');
	switch (normalized) {
		case 'янв':
		case 'января':
			return '01';
		case 'фев':
		case 'февраля':
			return '02';
		case 'мар':
		case 'марта':
			return '03';
		case 'апр':
		case 'апреля':
			return '04';
		case 'май':
		case 'мая':
			return '05';
		case 'июн':
		case 'июня':
			return '06';
		case 'июл':
		case 'июля':
			return '07';
		case 'авг':
		case 'августа':
			return '08';
		case 'сен':
		case 'сентября':
			return '09';
		case 'окт':
		case 'октября':
			return '10';
		case 'ноя':
		case 'ноября':
			return '11';
		case 'дек':
		case 'декабря':
			return '12';
		default:
			return null;
	}
}
