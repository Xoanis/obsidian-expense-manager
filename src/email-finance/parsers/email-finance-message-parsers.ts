import type {
	FinanceReceiptProposalRequest,
	FinanceTextProposalRequest,
} from '../../services/finance-intake-service';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';
import type {
	PlannedEmailFinanceReceiptUnit,
	PlannedEmailFinanceTextUnit,
	PlannedEmailFinanceUnit,
} from '../planning/email-finance-message-planner';
import { decodeCommonHtmlEntities, decodeEmailTransferText } from '../utils/email-content-normalizer';

export interface EmailFinanceParserResult {
	units: PlannedEmailFinanceUnit[];
	stop: boolean;
	parserId: string;
}

export interface EmailFinanceParserAttempt {
	parserId: string;
	matched: boolean;
	stop: boolean;
	reason: string;
	diagnostics?: Record<string, unknown>;
	units: PlannedEmailFinanceUnit[];
}

export interface EmailFinanceMessageParser {
	readonly id: string;
	parse(message: FinanceMailMessage): EmailFinanceParserAttempt;
}

export interface EmailFinanceMessageDebugSignals {
	senderDomain: string;
	subject: string;
	normalizedBodyLength: number;
	normalizedBodyPreview: string;
	linkCount: number;
	linkSamples: string[];
	imageSourceCount: number;
	imageSourceSamples: string[];
	dataUrlImageCount: number;
	dataUrlImageSamples: string[];
	qrUrlCandidateCount: number;
	qrUrlCandidateSamples: string[];
	fiscalFieldsFromBody: string | null;
	fiscalFieldsFromQrUrl: string | null;
}

export class CompositeEmailFinanceMessageParser {
	constructor(private readonly parsers: EmailFinanceMessageParser[]) {}

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt[] {
		const results: EmailFinanceParserAttempt[] = [];
		for (const parser of this.parsers) {
			const attempt = parser.parse(message);
			results.push(attempt);
			if (attempt.matched && attempt.stop) {
				break;
			}
		}
		return results;
	}
}

function matchedParserAttempt(
	parserId: string,
	units: PlannedEmailFinanceUnit[],
	options?: {
		stop?: boolean;
		reason?: string;
		diagnostics?: Record<string, unknown>;
	},
): EmailFinanceParserAttempt {
	return {
		parserId,
		matched: true,
		stop: options?.stop ?? false,
		reason: options?.reason ?? 'parser matched',
		diagnostics: options?.diagnostics,
		units,
	};
}

function noMatchParserAttempt(
	parserId: string,
	reason: string,
	diagnostics?: Record<string, unknown>,
): EmailFinanceParserAttempt {
	return {
		parserId,
		matched: false,
		stop: false,
		reason,
		diagnostics,
		units: [],
	};
}

export function createDefaultEmailFinanceMessageParsers(): EmailFinanceMessageParser[] {
	return [
		new MagnitReceiptEmailParser(),
		new LentaReceiptEmailParser(),
		new FiscalReceiptFieldsEmailParser(),
		new YandexCheckReceiptEmailParser(),
		new OzonReceiptEmailParser(),
		new ReceiptLinkEmailParser(),
		new ReceiptSummaryEmailParser(),
	];
}

export function collectEmailFinanceMessageDebugSignals(message: FinanceMailMessage): EmailFinanceMessageDebugSignals {
	const normalizedBody = normalizeMessageText(message);
	const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
	const from = decodeEmailTransferText(message.from?.trim() ?? '');
	const senderDomain = extractSenderDomain(from);
	const links = extractMessageLinks(message, normalizedBody);
	const imageSources = extractMessageImageSources(message);
	const dataUrlImages = imageSources.filter((source) => /^data:image\//i.test(source));
	const qrUrlCandidates = [...links, ...imageSources].filter((candidate) =>
		/api-lk-ofd\.taxcom\.ru\/images\/qr|resize\.yandex\.net\/mailservice|check\.yandex\.ru|receipt\.taxcom\.ru|lk\.ofd-magnit\.ru|api\.qrserver\.com\/v1\/create-qr-code|check\.lenta\.com|eco-check\.ru|prod\.upmetric\.ru\/receiptview|upmetric\.lenta\.com/i.test(candidate),
	);
	const fiscalFieldsFromBody = extractFiscalReceiptFields(normalizedBody);
	const fiscalFieldsFromQrUrl = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
	return {
		senderDomain,
		subject,
		normalizedBodyLength: normalizedBody.length,
		normalizedBodyPreview: normalizedBody.slice(0, 1500),
		linkCount: links.length,
		linkSamples: sanitizeDebugSourceSamples(links),
		imageSourceCount: imageSources.length,
		imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
		dataUrlImageCount: dataUrlImages.length,
		dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
		qrUrlCandidateCount: qrUrlCandidates.length,
		qrUrlCandidateSamples: sanitizeDebugSourceSamples(qrUrlCandidates),
		fiscalFieldsFromBody: fiscalFieldsFromBody ? buildRawReceiptQrPayload(fiscalFieldsFromBody) : null,
		fiscalFieldsFromQrUrl: fiscalFieldsFromQrUrl ? buildRawReceiptQrPayload(fiscalFieldsFromQrUrl) : null,
	};
}

class MagnitReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'magnit-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const senderDomain = extractSenderDomain(from);
		const links = extractMessageLinks(message, normalizedBody);
		const receiptPdfLink = links.find((link) => /lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul/i.test(link)) ?? null;
		const looksLikeBySender = /ofd-magnit\.ru/i.test(senderDomain);
		const looksLikeByKeyword = /магнит/i.test(`${subject}\n${normalizedBody}`);
		const looksLikeMagnitReceipt = Boolean(receiptPdfLink)
			|| looksLikeBySender
			|| looksLikeByKeyword;
		if (!looksLikeMagnitReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Magnit receipt', {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				looksLikeBySender,
				looksLikeByKeyword,
			});
		}

		const linkFields = extractMagnitReceiptFields(message, normalizedBody, links);
		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const operationType = extractReceiptOperationType(normalizedBody);
		if (!linkFields || !amount || !dateTime || !operationType) {
			return noMatchParserAttempt(this.id, 'Magnit receipt signals were found, but fiscal extraction is incomplete', {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				hasLinkFields: Boolean(linkFields),
				hasAmount: Boolean(amount),
				hasDateTime: Boolean(dateTime),
				hasOperationType: Boolean(operationType),
				amount,
				dateTime,
				operationType,
				linkFields,
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('magnit-fiscal-receipt-fields', {
				dateTime,
				amount,
				fn: linkFields.fn,
				i: linkFields.fd,
				fp: linkFields.fp,
				n: operationType,
			})], {
			stop: true,
			reason: 'Magnit receipt fiscal fields reconstructed from email content',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				amount,
				dateTime,
				operationType,
				linkFields,
			},
		});
	}
}

class LentaReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'lenta-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const senderDomain = extractSenderDomain(from);
		const links = extractMessageLinks(message, normalizedBody);
		const imageSources = extractMessageImageSources(message);
		const dataUrlImages = imageSources.filter((source) => /^data:image\//i.test(source));
		const qrUrlCandidates = [...links, ...imageSources];
		const hasLentaKeyword = /лента/i.test(`${subject}\n${normalizedBody}`);
		const hasLegacyLentaReceiptLink = links.some((link) => /online\.lenta\.com|RenderDoc|ofd\.ru\/b\//i.test(link));
		const hasTaxcomReceiptLink = links.some((link) => /receipt\.taxcom\.ru/i.test(link));
		const hasLentaReceiptRedirectLink = links.some((link) =>
			/check\.lenta\.com|eco-check\.ru|prod\.upmetric\.ru\/receiptview|upmetric\.lenta\.com/i.test(link),
		);
		const hasTaxcomQrImageLink = qrUrlCandidates.some((link) =>
			/receipt\.taxcom\.ru|api-lk-ofd\.taxcom\.ru\/images\/qr|resize\.yandex\.net\/mailservice/i.test(link),
		);
		const hasQrServerImageLink = qrUrlCandidates.some((link) => /api\.qrserver\.com\/v1\/create-qr-code/i.test(link));
		const looksLikeBySender = /(?:^|\.)ofd\.ru$/i.test(senderDomain)
			|| /(?:^|\.)taxcom\.ru$/i.test(senderDomain)
			|| /(?:^|\.)lenta\.com$/i.test(senderDomain);
		const looksLikeLentaReceipt = looksLikeBySender
			&& (
				hasLentaKeyword
				|| hasLegacyLentaReceiptLink
				|| hasTaxcomReceiptLink
				|| hasTaxcomQrImageLink
				|| hasLentaReceiptRedirectLink
				|| hasQrServerImageLink
			);
		if (!looksLikeLentaReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Lenta receipt', {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				looksLikeBySender,
			});
		}

		const receiptFields = extractLentaReceiptFields(message, normalizedBody, qrUrlCandidates);
		const inlineReceiptImageUnit = buildInlineDataUrlReceiptUnit(
			message,
			dataUrlImages,
			'lenta-inline-qr-image',
			'lenta-inline-qr',
		);
		if (!receiptFields && inlineReceiptImageUnit) {
			return matchedParserAttempt(this.id, [inlineReceiptImageUnit], {
				stop: true,
				reason: 'Lenta inline QR image extracted from email HTML',
				diagnostics: {
					senderDomain,
					linkCount: links.length,
					linkSamples: sanitizeDebugSourceSamples(links),
					imageSourceCount: imageSources.length,
					imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
					dataUrlImageCount: dataUrlImages.length,
					dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
					hasLentaKeyword,
					hasLegacyLentaReceiptLink,
					hasTaxcomReceiptLink,
					hasTaxcomQrImageLink,
					hasLentaReceiptRedirectLink,
					hasQrServerImageLink,
					inlineReceiptFileName: inlineReceiptImageUnit.request.fileName,
					inlineReceiptMimeType: inlineReceiptImageUnit.request.mimeType,
					inlineReceiptByteLength: inlineReceiptImageUnit.request.bytes.byteLength,
				},
			});
		}
		if (!receiptFields) {
			const qrFields = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
			return noMatchParserAttempt(this.id, 'Lenta receipt signals were found, but fiscal fields were not extracted', {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				amount: extractReceiptAmount(normalizedBody),
				dateTime: extractReceiptDateTime(normalizedBody),
				operationType: extractReceiptOperationType(normalizedBody),
				fiscalFieldsFromQrUrl: qrFields ? buildRawReceiptQrPayload(qrFields) : null,
				qrUrlCandidateCount: qrUrlCandidates.length,
				qrUrlCandidateSamples: sanitizeDebugSourceSamples(qrUrlCandidates),
				hasFn: Boolean(matchFirst(normalizedBody, [
					/серийный номер фн\s*[:=]?\s*(\d{10,})/i,
					/\bфн\s*[:=]?\s*(\d{10,})/i,
					/\bfn\s*[=:]\s*(\d{10,})/i,
				])),
				hasFd: Boolean(matchFirst(normalizedBody, [
					/\bфд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/i,
					/номер фд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/i,
					/\b(?:fd|i)\s*[=:]\s*(\d{1,})/i,
				])),
				hasFp: Boolean(matchFirst(normalizedBody, [
					/фпд\s*[:=]?\s*(\d{6,})/i,
					/фп\s*[:=]?\s*(\d{6,})/i,
					/\bfp\s*[=:]\s*(\d{6,})/i,
				])),
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('lenta-fiscal-receipt-fields', receiptFields)], {
			stop: true,
			reason: 'Lenta receipt fiscal fields extracted from email body',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				receiptFields,
			},
		});
	}
}

class YandexCheckReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'yandex-check-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => /check\.yandex\.ru/i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeByKeyword = /яндекс/i.test(normalizedBody) && /кассовый чек|ссылка на ваш чек/i.test(normalizedBody);
		const looksLikeYandexReceipt = receiptLinks.length > 0
			|| /check\.yandex\.ru/i.test(senderDomain)
			|| looksLikeByKeyword;
		if (!looksLikeYandexReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Yandex receipt', {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				looksLikeByKeyword,
			});
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

		return matchedParserAttempt(this.id, units, {
			stop: false,
			reason: receiptFields
				? 'Yandex receipt detected with fiscal fields and AI fallback summary'
				: 'Yandex receipt detected with AI fallback summary only',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				hasReceiptFields: Boolean(receiptFields),
				amount,
				dateTime,
				merchant,
			},
		});
	}
}

class OzonReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'ozon-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => /ozon\.ru\/my\/e-check\//i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeByKeyword = /ozon/i.test(normalizedBody) && /чек|e-check|receipt/i.test(normalizedBody);
		const looksLikeOzonReceipt = receiptLinks.length > 0
			|| /(?:^|\.)ozon\.ru$/i.test(senderDomain)
			|| /sender\.ozon\.ru/i.test(senderDomain)
			|| looksLikeByKeyword;
		if (!looksLikeOzonReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like an Ozon receipt', {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				looksLikeByKeyword,
			});
		}

		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const remotePdfLink = receiptLinks.find((link) => /ozon\.ru\/my\/e-check\/download\//i.test(link)) ?? null;
		const units: PlannedEmailFinanceUnit[] = [{
			kind: 'text',
			label: 'ozon-receipt-summary',
			remoteArtifactUrl: remotePdfLink ?? undefined,
			remoteArtifactFileName: remotePdfLink ? buildRemotePdfFileName(remotePdfLink, 'ozon-e-check') : undefined,
			remoteArtifactMimeType: remotePdfLink ? 'application/pdf' : undefined,
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

		return matchedParserAttempt(this.id, units, {
			stop: false,
			reason: remotePdfLink
				? 'Ozon receipt detected with remote PDF link'
				: 'Ozon receipt detected with summary only',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				remotePdfLinkPresent: Boolean(remotePdfLink),
				amount,
				dateTime,
			},
		});
	}
}

class ReceiptLinkEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-link';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, message.subject ?? ''));
		if (receiptLinks.length === 0) {
			return noMatchParserAttempt(this.id, 'no receipt-like links found', {
				linkCount: links.length,
				receiptLinkCount: 0,
			});
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

		return matchedParserAttempt(this.id, [unit], {
			stop: false,
			reason: 'receipt-like links found in email content',
			diagnostics: {
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				focusedExcerptLength: focusedExcerpt.length,
			},
		});
	}
}

class FiscalReceiptFieldsEmailParser implements EmailFinanceMessageParser {
	readonly id = 'fiscal-receipt-fields';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return noMatchParserAttempt(this.id, 'normalized message body is empty');
		}

		const receiptFields = extractFiscalReceiptFields(normalizedBody);
		if (!receiptFields) {
			return noMatchParserAttempt(this.id, 'did not find a full set of fiscal receipt fields', {
				amount: extractReceiptAmount(normalizedBody),
				dateTime: extractReceiptDateTime(normalizedBody),
				operationType: extractReceiptOperationType(normalizedBody),
			});
		}

		const qrPayload = buildRawReceiptQrPayload(receiptFields);
		if (!qrPayload) {
			return noMatchParserAttempt(this.id, 'fiscal fields were found but qr payload could not be built', {
				receiptFields,
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('fiscal-receipt-fields', receiptFields)], {
			stop: true,
			reason: 'generic fiscal receipt fields were extracted from email text',
			diagnostics: {
				receiptFields,
				qrPayload,
			},
		});
	}
}

class ReceiptSummaryEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-summary';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return noMatchParserAttempt(this.id, 'normalized message body is empty');
		}

		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
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
			return noMatchParserAttempt(this.id, 'message does not have enough receipt-like signals for summary fallback', {
				receiptLinkCount: receiptLinks.length,
				amount,
				dateTime,
				merchant,
				operationType,
				focusedExcerptLength: focusedExcerpt.length,
			});
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

		return matchedParserAttempt(this.id, [unit], {
			stop: false,
			reason: 'receipt-like message summary prepared for downstream extraction',
			diagnostics: {
				receiptLinkCount: receiptLinks.length,
				amount,
				dateTime,
				merchant,
				operationType,
				focusedExcerptLength: focusedExcerpt.length,
			},
		});
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
		/серийный номер фн\s*[:=]?\s*(\d{10,})/i,
		/\bфн\s*[:=]?\s*(\d{10,})/i,
		/\bfn\s*[=:]\s*(\d{10,})/i,
	]);
	const documentNumber = matchFirst(normalized, [
		/\bфд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/i,
		/номер фд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/i,
		/\b(?:fd|i)\s*[=:]\s*(\d{1,})/i,
	]);
	const fiscalSign = matchFirst(normalized, [
		/фпд\s*[:=]?\s*(\d{6,})/i,
		/фп\s*[:=]?\s*(\d{6,})/i,
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
		/итог\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сколько\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/безналичными\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сумма\s+расч[её]та\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/(?:сумма(?:\s+к\s+оплате)?|к\s+оплате|оплачено|total|amount)\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
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

	const qrAmountMatch = value.match(/\bs\s*[=:]\s*([0-9]+(?:[.,][0-9]{1,2})?)\b/i)?.[1];
	if (qrAmountMatch && /\b(?:fn|fp|fd|i|n)\s*[=:]/i.test(value)) {
		const normalized = qrAmountMatch.replace(',', '.');
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

	const shortDottedDate = value.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2})\s+(\d{2}):(\d{2})\b/);
	if (shortDottedDate) {
		const [, day, month, year, hour, minute] = shortDottedDate;
		return `${normalizeTwoDigitYear(year)}${pad2(month)}${pad2(day)}T${hour}${minute}`;
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
	const explicitOperationType = value.match(/\bn\s*[=:]\s*([1-4])\b/i)?.[1] as '1' | '2' | '3' | '4' | undefined;
	if (explicitOperationType) {
		return explicitOperationType;
	}
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

function buildFiscalReceiptUnit(
	label: string,
	fields: ExtractedFiscalReceiptFields,
): PlannedEmailFinanceTextUnit {
	return {
		kind: 'text',
		label,
		request: ({
			text: buildRawReceiptQrPayload(fields),
			intent: 'neutral',
			source: 'email',
		} as FinanceTextProposalRequest),
	};
}

function buildInlineDataUrlReceiptUnit(
	message: FinanceMailMessage,
	dataUrlImages: string[],
	label: string,
	fileBaseName: string,
): PlannedEmailFinanceReceiptUnit | null {
	const bestDataUrlImage = pickBestInlineDataUrlImage(dataUrlImages);
	if (!bestDataUrlImage) {
		return null;
	}

	const parsed = parseImageDataUrl(bestDataUrlImage);
	if (!parsed) {
		return null;
	}

	return {
		kind: 'receipt',
		label,
		request: ({
			bytes: parsed.bytes,
			fileName: `${fileBaseName}.${parsed.extension}`,
			mimeType: parsed.mimeType,
			caption: buildInlineReceiptCaption(message, parsed.mimeType),
			intent: 'neutral',
			source: 'email',
		} as FinanceReceiptProposalRequest),
	};
}

function buildInlineReceiptCaption(message: FinanceMailMessage, mimeType: string): string {
	const subject = message.subject?.trim() ?? '';
	const from = message.from?.trim() ?? '';
	return [
		subject,
		from ? `From: ${from}` : '',
		`Inline receipt QR image extracted from email HTML (${mimeType})`,
	].filter(Boolean).join(' | ');
}

function pickBestInlineDataUrlImage(dataUrlImages: string[]): string | null {
	if (dataUrlImages.length === 0) {
		return null;
	}

	return dataUrlImages
		.slice()
		.sort((left, right) => estimateDataUrlPayloadLength(right) - estimateDataUrlPayloadLength(left))[0] ?? null;
}

function estimateDataUrlPayloadLength(dataUrl: string): number {
	return dataUrl.match(/base64,([\s\S]+)$/i)?.[1]?.length ?? 0;
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; extension: string; bytes: ArrayBuffer } | null {
	const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
	if (!match) {
		return null;
	}

	const [, mimeType, base64Payload] = match;
	const cleanedBase64 = base64Payload.replace(/\s+/g, '');
	if (!cleanedBase64) {
		return null;
	}

	const binary = atob(cleanedBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return {
		mimeType: mimeType.toLowerCase(),
		extension: extensionFromMimeType(mimeType),
		bytes: bytes.buffer,
	};
}

function extensionFromMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		case 'image/gif':
			return 'gif';
		case 'image/bmp':
			return 'bmp';
		default:
			return 'png';
	}
}

function pad2(value: string): string {
	return value.padStart(2, '0');
}

function normalizeTwoDigitYear(value: string): string {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return `20${value}`;
	}
	return parsed >= 70 ? `19${value}` : `20${value}`;
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

function extractMagnitReceiptFieldsFromLink(link: string | null): { fn: string; fd: string; fp: string } | null {
	if (!link) {
		return null;
	}

	try {
		const url = new URL(link);
		const fn = url.searchParams.get('fn')?.trim() ?? '';
		const fd = url.searchParams.get('fd')?.trim() ?? '';
		const fp = (url.searchParams.get('fs') ?? url.searchParams.get('fp') ?? '').trim();
		if (!fn || !fd || !fp) {
			return null;
		}

		return { fn, fd, fp };
	} catch {
		return null;
	}
}

function extractMagnitReceiptFields(
	message: FinanceMailMessage,
	normalizedBody: string,
	links: string[],
): { fn: string; fd: string; fp: string } | null {
	const directLink = links.find((link) => /lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul/i.test(link)) ?? null;
	const fromLink = extractMagnitReceiptFieldsFromLink(directLink);
	if (fromLink) {
		return fromLink;
	}

	const rawCandidates = [
		normalizedBody,
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
	]
		.filter(Boolean)
		.map((value) => value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ''));

	for (const candidate of rawCandidates) {
		const magnitLinkMatch = candidate.match(/https?:\/\/lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul\?[^\s"'<>]+/i)?.[0]
			?? candidate.match(/lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul\?[^\s"'<>]+/i)?.[0];
		if (magnitLinkMatch) {
			const normalizedLink = normalizeExtractedLink(
				magnitLinkMatch.startsWith('http') ? magnitLinkMatch : `https://${magnitLinkMatch}`,
			);
			const extracted = extractMagnitReceiptFieldsFromLink(normalizedLink);
			if (extracted) {
				return extracted;
			}
		}

		const queryMatch = candidate.match(/(?:\?|&)fn=(\d{10,})(?:&|$).*?(?:\?|&)(?:fs|fp)=(\d{6,})(?:&|$).*?(?:\?|&)fd=(\d{1,})(?:&|$)/i)
			?? candidate.match(/(?:\?|&)fd=(\d{1,})(?:&|$).*?(?:\?|&)fn=(\d{10,})(?:&|$).*?(?:\?|&)(?:fs|fp)=(\d{6,})(?:&|$)/i);
		if (queryMatch) {
			if (queryMatch.length === 4) {
				const [, first, second, third] = queryMatch;
				if (candidate.includes(`fn=${first}`)) {
					return { fn: first, fp: second, fd: third };
				}
				return { fd: first, fn: second, fp: third };
			}
		}
	}

	return null;
}

function extractLentaReceiptFields(
	message: FinanceMailMessage,
	normalizedBody: string,
	qrUrlCandidates: string[],
): ExtractedFiscalReceiptFields | null {
	const fromQrUrl = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
	if (fromQrUrl) {
		return fromQrUrl;
	}

	const rawCandidates = [
		normalizedBody,
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
	];
	for (const candidate of rawCandidates) {
		const extracted = extractFiscalReceiptFieldsFromQrUrlCandidates(extractCandidateLinks(candidate));
		if (extracted) {
			return extracted;
		}
	}

	return extractFiscalReceiptFields(normalizedBody);
}

function buildRemotePdfFileName(link: string, fallbackBaseName: string): string {
	try {
		const url = new URL(link);
		const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
		if (!lastSegment) {
			return `${fallbackBaseName}.pdf`;
		}
		return lastSegment.toLowerCase().endsWith('.pdf') ? lastSegment : `${lastSegment}.pdf`;
	} catch {
		return `${fallbackBaseName}.pdf`;
	}
}

function normalizeMessageText(message: FinanceMailMessage): string {
	return [
		decodeMessagePart(message.subject?.trim() ?? ''),
		decodeMessagePart(message.textBody?.trim() ?? ''),
		decodeMessagePart(message.htmlBody?.trim() ?? ''),
		decodeMessagePart(message.textBodyPreview?.trim() ?? ''),
		decodeMessagePart(message.htmlBodyPreview?.trim() ?? ''),
	].filter(Boolean).join('\n\n');
}

function decodeMessagePart(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		decodeEmailTransferText(value)
			.replace(/href\s*=\s*3D/gi, 'href=')
			.replace(/\s+3D(?=["'])/gi, '='),
	);
}

function extractMessageLinks(message: FinanceMailMessage, normalizedBody: string): string[] {
	const parts = [
		normalizedBody,
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
	];

	const links = new Set<string>();
	for (const part of parts) {
		for (const link of extractCandidateLinks(part)) {
			links.add(link);
		}
	}

	const htmlParts = [
		prepareHtmlForAttributeExtraction(message.htmlBody ?? ''),
		prepareHtmlForAttributeExtraction(message.htmlBodyPreview ?? ''),
	];
	for (const html of htmlParts) {
		for (const link of extractHtmlHrefLinks(html)) {
			links.add(link);
		}
	}

	return Array.from(links);
}

function extractMessageImageSources(message: FinanceMailMessage): string[] {
	const htmlParts = [
		prepareHtmlForAttributeExtraction(message.htmlBody ?? ''),
		prepareHtmlForAttributeExtraction(message.htmlBodyPreview ?? ''),
	];

	const imageSources = new Set<string>();
	for (const html of htmlParts) {
		for (const source of extractHtmlImageSourceLinks(html)) {
			imageSources.add(source);
		}
	}

	return Array.from(imageSources);
}

function extractCandidateLinks(value: string): string[] {
	const decoded = decodeMessagePart(value);
	const matches = decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedLink(match[0]))
			.filter((link): link is string => Boolean(link)),
	));
}

function extractHtmlHrefLinks(value: string): string[] {
	if (!value) {
		return [];
	}

	const matches = value.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedLink(match[1] ?? match[2] ?? match[3] ?? ''))
			.filter((link): link is string => Boolean(link)),
	));
}

function extractHtmlImageSourceLinks(value: string): string[] {
	if (!value) {
		return [];
	}

	const matches = value.matchAll(/src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedSource(match[1] ?? match[2] ?? match[3] ?? ''))
			.filter((source): source is string => Boolean(source)),
	));
}

function normalizeExtractedLink(value: string): string | null {
	if (!value) {
		return null;
	}

	const normalized = decodeUrlLikeValue(value)
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.replace(/\s+/g, '')
		.replace(/[>"']+$/g, '')
		.trim();
	if (!/^https?:\/\//i.test(normalized)) {
		return null;
	}

	return normalized;
}

function normalizeExtractedSource(value: string): string | null {
	if (!value) {
		return null;
	}

	const normalized = decodeUrlLikeValue(value)
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.replace(/\s+/g, '')
		.replace(/[>"']+$/g, '')
		.trim();
	if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
		return normalized;
	}

	return null;
}

function sanitizeDebugSourceSamples(values: string[], maxItems = 5): string[] {
	return values.slice(0, maxItems).map((value) => sanitizeDebugSource(value));
}

function sanitizeDebugSource(value: string): string {
	if (!value) {
		return '';
	}
	if (!/^data:image\//i.test(value)) {
		return value;
	}

	const mimeType = value.match(/^data:(image\/[a-z0-9.+-]+);/i)?.[1] ?? 'image/unknown';
	const base64Length = value.match(/base64,([\s\S]+)$/i)?.[1]?.length ?? 0;
	return `data:${mimeType};base64,<omitted;length=${base64Length}>`;
}

function prepareHtmlForAttributeExtraction(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		value
			.replace(/\r\n/g, '\n')
			.replace(/=\n/g, '')
			.replace(/href\s*=\s*3D/gi, 'href=')
			.replace(/src\s*=\s*3D/gi, 'src=')
			.replace(/\s+3D(?=["'])/gi, '='),
	);
}

function decodeUrlLikeValue(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		value
			.replace(/\r\n/g, '\n')
			.replace(/=\n/g, '')
			.replace(/=3D/gi, '=')
			.replace(/=26/gi, '&')
			.replace(/=3A/gi, ':')
			.replace(/=2F/gi, '/')
			.replace(/=3F/gi, '?')
			.replace(/=25/gi, '%')
			.replace(/=23/gi, '#')
			.replace(/=2B/gi, '+'),
	);
}

function extractFiscalReceiptFieldsFromQrUrlCandidates(values: string[]): ExtractedFiscalReceiptFields | null {
	for (const value of values) {
		const extracted = extractFiscalReceiptFieldsFromQrUrlCandidate(value);
		if (extracted) {
			return extracted;
		}
	}
	return null;
}

function extractFiscalReceiptFieldsFromQrUrlCandidate(value: string): ExtractedFiscalReceiptFields | null {
	const normalized = normalizeExtractedLink(value);
	if (!normalized) {
		return null;
	}

	const candidates = new Set<string>([normalized]);
	try {
		const url = new URL(normalized);
		const nestedUrl = url.searchParams.get('url');
		if (nestedUrl) {
			candidates.add(decodeRepeatedUrlComponent(nestedUrl));
		}
	} catch {
		// ignore malformed nested URLs and continue with the raw candidate
	}

	for (const candidate of candidates) {
		const extracted = extractFiscalReceiptFieldsFromResolvedQrUrl(candidate);
		if (extracted) {
			return extracted;
		}
	}

	return null;
}

function extractFiscalReceiptFieldsFromResolvedQrUrl(value: string): ExtractedFiscalReceiptFields | null {
	try {
		const url = new URL(value);
		const payload = url.searchParams.get('code') ?? url.searchParams.get('data');
		if (!payload) {
			return null;
		}

		const decodedPayload = decodeRepeatedUrlComponent(payload);
		for (const candidate of buildQrPayloadCandidates(decodedPayload)) {
			const extracted = extractFiscalReceiptFields(candidate);
			if (extracted) {
				return extracted;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function buildQrPayloadCandidates(value: string): string[] {
	const cleaned = value
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.trim();
	const variants = new Set<string>();
	if (cleaned) {
		variants.add(cleaned);
		variants.add(cleaned.replace(/\s+/g, ''));
	}

	const repaired = repairCorruptedQrPayload(cleaned);
	if (repaired && repaired !== cleaned) {
		variants.add(repaired);
		variants.add(repaired.replace(/\s+/g, ''));
	}

	return Array.from(variants).filter(Boolean);
}

function repairCorruptedQrPayload(value: string): string {
	if (!value) {
		return '';
	}

	return value
		.split('&')
		.map((segment) => repairCorruptedQrSegment(segment))
		.join('&');
}

function repairCorruptedQrSegment(segment: string): string {
	const trimmed = segment.trim();
	const match = trimmed.match(/^([a-z]{1,2})\s+(.+)$/i);
	if (!match) {
		return trimmed;
	}

	const [, key, rawValue] = match;
	const normalizedKey = key.toLowerCase();
	let normalizedValue = rawValue.trim();
	if (normalizedKey === 't' && /^\d{6}T\d{4}$/.test(normalizedValue)) {
		normalizedValue = `20${normalizedValue}`;
	}

	return `${key}=${normalizedValue}`;
}

function decodeRepeatedUrlComponent(value: string, maxRounds = 3): string {
	let current = value;
	for (let i = 0; i < maxRounds; i += 1) {
		try {
			const decoded = decodeURIComponent(current);
			if (decoded === current) {
				return decoded;
			}
			current = decoded;
		} catch {
			return current;
		}
	}
	return current;
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
