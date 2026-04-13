import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

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

await runBundledTypeScriptTests();

console.log('All tests passed.');

async function runBundledTypeScriptTests() {
	const generatedDir = path.resolve(process.cwd(), 'tests', '.generated');
	await mkdir(generatedDir, { recursive: true });

	const configPath = path.resolve(process.cwd(), 'tsconfig.json');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(formatDiagnostics([configFile.error]));
	}

	const parsedConfig = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		process.cwd(),
		{
			outDir: generatedDir,
			rootDir: process.cwd(),
			noEmit: false,
			declaration: false,
			skipLibCheck: true,
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
			inlineSourceMap: true,
			inlineSources: true,
		},
		configPath,
	);
	const entryPoints = [
		path.resolve(process.cwd(), 'tests', 'email-finance-regressions.ts'),
		path.resolve(process.cwd(), 'tests', 'email-finance-rebuild-compat.ts'),
		path.resolve(process.cwd(), 'tests', 'email-finance-sync-state.ts'),
		path.resolve(process.cwd(), 'tests', 'email-sync-telegram-notification.ts'),
		path.resolve(process.cwd(), 'tests', 'finance-review-workflow-service.ts'),
		path.resolve(process.cwd(), 'tests', 'receipt-qr-reconstruction.ts'),
	];
	const program = ts.createProgram({
		rootNames: entryPoints,
		options: parsedConfig.options,
	});
	const emitResult = program.emit();
	if (emitResult.emitSkipped) {
		throw new Error(formatDiagnostics(emitResult.diagnostics));
	}

	const require = createRequire(import.meta.url);
	for (const entryPoint of entryPoints) {
		const outfile = path.join(
			generatedDir,
			'tests',
			`${path.basename(entryPoint, '.ts')}.js`,
		);
		delete require.cache[require.resolve(outfile)];
		const loadedModule = require(outfile);
		if (typeof loadedModule?.default === 'function') {
			await loadedModule.default();
		}
	}
}

function formatDiagnostics(diagnostics) {
	return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => '\n',
	});
}
