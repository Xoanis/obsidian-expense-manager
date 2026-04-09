import * as assert from 'node:assert/strict';

import {
	buildRawReceiptQrCandidates,
	buildRawReceiptQrPayload,
} from '../src/utils/qr-parser';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('rebuilds canonical qrraw payload from stored receipt fields', () => {
	const payload = buildRawReceiptQrPayload({
		amount: 469.62,
		dateTime: '2026-02-11T21:48:00',
		fn: '7380440902687121',
		fd: '103750',
		fp: '823589924',
		receiptOperationType: 1,
	});

	assert.equal(
		payload,
		't=20260211T2148&s=469.62&fn=7380440902687121&i=103750&fp=823589924&n=1',
	);
});

run('tries both possible receipt operation types for expense notes when n is missing', () => {
	const candidates = buildRawReceiptQrCandidates({
		type: 'expense',
		amount: 225.88,
		dateTime: '2026-02-15T18:28:00',
		fn: '7380440903139936',
		fd: '34082',
		fp: '2736797946',
	});

	assert.deepEqual(candidates, [
		't=20260215T1828&s=225.88&fn=7380440903139936&i=34082&fp=2736797946&n=1',
		't=20260215T1828&s=225.88&fn=7380440903139936&i=34082&fp=2736797946&n=4',
	]);
});

run('tries both possible receipt operation types for income notes when n is missing', () => {
	const candidates = buildRawReceiptQrCandidates({
		type: 'income',
		amount: 1500,
		dateTime: '2026-02-14T15:02:00',
		fn: '7381440900906552',
		fd: '1365',
		fp: '681846341',
	});

	assert.deepEqual(candidates, [
		't=20260214T1502&s=1500.00&fn=7381440900906552&i=1365&fp=681846341&n=2',
		't=20260214T1502&s=1500.00&fn=7381440900906552&i=1365&fp=681846341&n=3',
	]);
});
