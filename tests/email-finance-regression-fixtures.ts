import type { FinanceMailMessage } from '../src/email-finance/transport/finance-mail-provider';

export interface ResolvedReceiptFixture {
	name: string;
	message: FinanceMailMessage;
	expectedQrPayload: string;
}

export interface VendorAdapterFixture {
	name: string;
	message: FinanceMailMessage;
	expectedParserId: string;
	expectedUnitLabel: string;
}

export interface PdfFiscalTextFixture {
	name: string;
	text: string;
	expectedQrPayload: string;
}

function createMessageFixture(overrides: Partial<FinanceMailMessage>): FinanceMailMessage {
	return {
		id: overrides.id ?? 'fixture-message',
		receivedAt: overrides.receivedAt ?? '2026-01-01T00:00:00.000Z',
		from: overrides.from,
		subject: overrides.subject,
		textBody: overrides.textBody,
		htmlBody: overrides.htmlBody,
		textBodyPreview: overrides.textBodyPreview,
		htmlBodyPreview: overrides.htmlBodyPreview,
		threadId: overrides.threadId,
		attachmentNames: overrides.attachmentNames ?? [],
		attachments: overrides.attachments ?? [],
	};
}

export const resolvedReceiptFixtures: ResolvedReceiptFixture[] = [
	{
		name: 'Yandex drive receipt resolves from body fields and receipt link',
		expectedQrPayload: 't=20260215T1828&s=225.88&fn=7380440903139936&i=34082&fp=2736797946&n=1',
		message: createMessageFixture({
			id: 'fixture-yandex-drive',
			receivedAt: '2026-02-15T15:29:00.000Z',
			from: 'ООО "ЯНДЕКС.ДРАЙВ" <noreply@check.yandex.ru>',
			subject: 'Чек + (1) подарок 💌 🎁',
			htmlBody: `
				<p>Ссылка на ваш чек:
					<a href="https://check.yandex.ru/?n=34082&fn=7380440903139936&fpd=2736797946">https://check.yandex.ru/?n=34082&fn=7380440903139936&fpd=2736797946</a>
				</p>
				<p>Кассовый чек / Приход</p>
				<p>Когда 15 фев 2026 18:28</p>
				<p>Сколько 225.88 ₽</p>
				<p>ФН 7380440903139936</p>
				<p>ФД 34082</p>
				<p>ФПД 2736797946</p>
			`,
		}),
	},
	{
		name: 'Magnit receipt resolves from PDF link fields plus body amount and date',
		expectedQrPayload: 't=20260407T2009&s=1306.84&fn=7380440902990696&i=3190&fp=0017878488&n=1',
		message: createMessageFixture({
			id: 'fixture-magnit',
			receivedAt: '2026-04-07T17:10:26.000Z',
			from: 'info@ofd-magnit.ru',
			subject: 'Чек 0017878488  и Подарок от МАГНИТ !',
			htmlBody: `
				<html><body>
					<a href="https://lk.ofd-magnit.ru/CheckWebApp/pdf.zul?fn=7380440902990696&fs=0017878488&fd=3190">Скачать чек</a>
					<table>
						<tr><td>Кассовый чек / Приход</td></tr>
						<tr><td>07.04.26 20:09</td></tr>
						<tr><td>ИТОГО:</td><td>1306.84</td></tr>
						<tr><td>БЕЗНАЛИЧНЫМИ:</td><td>1306.84</td></tr>
					</table>
				</body></html>
			`,
		}),
	},
	{
		name: 'HTML receipt markup resolves timestamp from time datetime attribute',
		expectedQrPayload: 't=20260410T1108&s=149.00&fn=7380440902990696&i=1261&fp=1234567890&n=1',
		message: createMessageFixture({
			id: 'fixture-html-datetime-attribute',
			receivedAt: '2026-04-10T08:09:12.000Z',
			from: 'bank@example.test',
			subject: 'Вы заплатили с карты',
			htmlBody: `
				<html><body>
					<article class="operation-card">
						<time datetime="2026-04-10T11:08:49+03:00">10 апреля 2026, 11:08</time>
						<div>Кассовый чек / Приход</div>
						<div>Сумма: 149.00 ₽</div>
						<div>ФН 7380440902990696</div>
						<div>Фискальный документ 1261</div>
						<div>ФПД 1234567890</div>
					</article>
				</body></html>
			`,
		}),
	},
	{
		name: 'Tutu receipt resolves from body-only fiscal fields',
		expectedQrPayload: 't=20260220T1357&s=14436.00&fn=7380440902668375&i=112523&fp=3958914017&n=1',
		message: createMessageFixture({
			id: 'fixture-tutu',
			receivedAt: '2026-02-20T10:58:43.000Z',
			from: 'Туту <usercommunication@tutu.ru>',
			subject: 'Ваш чек + (1) подарок',
			textBody: `
				КАССОВЫЙ ЧЕК
				Общество с ограниченной ответственностью "Новые Туристические Технологии"
				ЧЕК №482 (ПРИХОД)
				Сервисный сбор, заказ №AT26021647444124 582.00 * 1 = 582.00
				Авиабилеты, заказ №AT26021647444124, Тариф 13854.00 * 1 = 13854.00
				ИТОГО 14436.00
				БЕЗНАЛИЧНЫМИ: 14436.00
				20.02.26 13:57
				№ ФН: 7380440902668375
				№ ФД: 112523
				ФП 3958914017
			`,
		}),
	},
	{
		name: 'Citydrive receipt resolves from QR-like URL payload',
		expectedQrPayload: 't=20260211T2148&s=469.62&fn=7380440902687121&i=103750&fp=823589924&n=1',
		message: createMessageFixture({
			id: 'fixture-citydrive',
			receivedAt: '2026-02-11T18:49:00.000Z',
			from: 'Ситидрайв <we@citydrive.ru>',
			subject: 'Чек Ситидрайв',
			htmlBody: `
				<html><body>
					<p>Чек Ситидрайв</p>
					<img src="https://qr.cloudpayments.ru/receipt?q=t%3d20260211T214834%26s%3d469.62%26fn%3d7380440902687121%26i%3d103750%26fp%3d823589924%26n%3d1" />
					<a href="https://lk.platformaofd.ru/web/noauth/cheque?fn=7380440902687121&fp=823589924&i=103750">Открыть чек</a>
				</body></html>
			`,
		}),
	},
];

export const vendorAdapterFixtures: VendorAdapterFixture[] = [
	{
		name: 'Ozon adapter still matches when generic evidence cannot resolve qr payload',
		expectedParserId: 'ozon-receipt',
		expectedUnitLabel: 'text:ozon-receipt-summary',
		message: createMessageFixture({
			id: 'fixture-ozon',
			receivedAt: '2026-03-29T10:02:42.000Z',
			from: 'Ozon <noreply@sender.ozon.ru>',
			subject: 'Ваш чек + (1) подарок',
			htmlBody: `
				<html><body>
					<p>Ваш чек + (1) подарок</p>
					<a href="https://ozon.ru/my/e-check/download/uzOm3-37207641-0064-f7e3a09b-710f-477a-a2e5-f374d2c05957-0-0?mcp_no_minify&t_usr=37207641&userid=37207641">Скачать чек PDF</a>
					<a href="https://ozon.ru/my/e-check/show/uzOm3-37207641-0064-f7e3a09b-710f-477a-a2e5-f374d2c05957-0-0">Открыть чек</a>
				</body></html>
			`,
		}),
	},
];

export const pdfFiscalTextFixtures: PdfFiscalTextFixture[] = [
	{
		name: 'CloudPayments PDF text plus caption yields canonical fiscal payload',
		expectedQrPayload: 't=20260214T1502&s=1500.00&fn=7381440900906552&i=1365&fp=681846341&n=1',
		text: `
			Кассовый чек №1365 / Приход
			ИП Сподобаева Мария Александровна
			Фискальный документ #1365
			Дата выдачи 14 февраля 2026 г. в 15:02
			ФН 7381440900906552
			Фискальный признак 681846341
			Сумма заказа 1 500,00 ₽
		`,
	},
	{
		name: 'PDF fiscal text resolves dotted timestamp with seconds',
		expectedQrPayload: 't=20260410T1215&s=1261.00&fn=7380440902990696&i=48455&fp=1234567890&n=1',
		text: `
			Кассовый чек / Приход
			ООО "Тестовый магазин"
			Дата операции: 10.04.2026 12:15:10
			Фискальный документ 48455
			ФН 7380440902990696
			Фискальный признак 1234567890
			ИТОГО 1 261,00 ₽
		`,
	},
];
