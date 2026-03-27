import assert from 'node:assert/strict';

function run(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

function resolveDescription(sourceText, extractedDescription) {
	if (typeof extractedDescription === 'string' && extractedDescription.trim()) {
		return extractedDescription.trim();
	}

	const normalizedSource = typeof sourceText === 'string' ? sourceText.trim() : '';
	return normalizedSource || undefined;
}

run('keeps valid extracted latin description instead of replacing it with source text', () => {
	const result = resolveDescription(
		'Покупка в магазине',
		'SBERPRIME MOSCOW RUS',
	);

	assert.equal(result, 'SBERPRIME MOSCOW RUS');
});

run('falls back to source text only when extracted description is missing', () => {
	const result = resolveDescription(
		'Купил кофе 320 руб',
		null,
	);

	assert.equal(result, 'Купил кофе 320 руб');
});

console.log('All tests passed.');
