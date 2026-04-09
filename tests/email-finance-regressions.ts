import * as assert from 'node:assert/strict';

import {
	buildRawReceiptQrPayload,
	collectEmailFinanceMessageDebugSignals,
	CompositeEmailFinanceMessageParser,
	createDefaultEmailFinanceMessageParsers,
	extractFiscalReceiptFields,
} from '../src/email-finance/parsers/email-finance-message-parsers';
import {
	pdfFiscalTextFixtures,
	resolvedReceiptFixtures,
	vendorAdapterFixtures,
} from './email-finance-regression-fixtures';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

for (const fixture of resolvedReceiptFixtures) {
	run(`resolved receipt evidence: ${fixture.name}`, () => {
		const parserChain = new CompositeEmailFinanceMessageParser(createDefaultEmailFinanceMessageParsers());
		const attempts = parserChain.parse(fixture.message);
		const firstAttempt = attempts[0];
		assert.ok(firstAttempt, 'Expected at least one parser attempt');
		assert.equal(firstAttempt.parserId, 'resolved-receipt-evidence');
		assert.equal(firstAttempt.matched, true);
		assert.equal(firstAttempt.stop, true);
		assert.deepEqual(firstAttempt.units.map((unit) => `${unit.kind}:${unit.label}`), ['text:resolved-fiscal-evidence']);

		const debugSignals = collectEmailFinanceMessageDebugSignals(fixture.message);
		assert.equal(debugSignals.evidenceSummary.resolvedFiscalQrPayload, fixture.expectedQrPayload);
		const directFiscalSource = debugSignals.fiscalFieldsFromQrUrl ?? debugSignals.fiscalFieldsFromBody;
		if (directFiscalSource !== null) {
			assert.equal(directFiscalSource, fixture.expectedQrPayload);
		}
	});
}

for (const fixture of vendorAdapterFixtures) {
	run(`vendor adapter remains available: ${fixture.name}`, () => {
		const parserChain = new CompositeEmailFinanceMessageParser(createDefaultEmailFinanceMessageParsers());
		const attempts = parserChain.parse(fixture.message);
		const genericAttempt = attempts[0];
		assert.ok(genericAttempt, 'Expected generic evidence attempt to run first');
		assert.equal(genericAttempt.parserId, 'resolved-receipt-evidence');
		assert.equal(genericAttempt.matched, false);

		const adapterAttempt = attempts.find((attempt) => attempt.parserId === fixture.expectedParserId);
		assert.ok(adapterAttempt, `Expected parser attempt ${fixture.expectedParserId}`);
		assert.equal(adapterAttempt?.matched, true);
		assert.equal(adapterAttempt?.units.map((unit) => `${unit.kind}:${unit.label}`)[0], fixture.expectedUnitLabel);
	});
}

for (const fixture of pdfFiscalTextFixtures) {
	run(`pdf fiscal text extraction: ${fixture.name}`, () => {
		const fields = extractFiscalReceiptFields(fixture.text);
		assert.ok(fields, 'Expected fiscal fields to be extracted from PDF text fixture');
		if (!fields) {
			throw new Error('Expected fiscal fields to be extracted from PDF text fixture');
		}
		assert.equal(buildRawReceiptQrPayload(fields), fixture.expectedQrPayload);
	});
}
