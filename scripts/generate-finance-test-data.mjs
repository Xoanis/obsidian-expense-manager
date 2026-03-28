import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_COUNT = 500;
const DEFAULT_MONTHS = 24;
const GENERATED_TAG = 'generated-test-data';

const EXPENSE_CATEGORIES = [
	{
		name: 'Food',
		descriptions: ['Groceries', 'Lunch', 'Dinner', 'Coffee', 'Bakery', 'Delivery'],
		min: 250,
		max: 4500,
	},
	{
		name: 'Transport',
		descriptions: ['Taxi', 'Metro', 'Fuel', 'Parking', 'Train ticket'],
		min: 120,
		max: 6000,
	},
	{
		name: 'Shopping',
		descriptions: ['Clothes', 'Marketplace order', 'Home goods', 'Electronics accessory'],
		min: 500,
		max: 18000,
	},
	{
		name: 'Bills',
		descriptions: ['Rent', 'Electricity', 'Internet', 'Mobile plan'],
		min: 800,
		max: 35000,
	},
	{
		name: 'Healthcare',
		descriptions: ['Pharmacy', 'Doctor visit', 'Lab tests', 'Vitamins'],
		min: 300,
		max: 12000,
	},
	{
		name: 'Entertainment',
		descriptions: ['Cinema', 'Concert', 'Books', 'Streaming', 'Weekend trip'],
		min: 250,
		max: 15000,
	},
	{
		name: 'Education',
		descriptions: ['Course', 'Books', 'Workshop', 'Subscription'],
		min: 500,
		max: 25000,
	},
];

const INCOME_CATEGORIES = [
	{
		name: 'Salary',
		descriptions: ['Salary', 'Bonus', 'Advance'],
		min: 45000,
		max: 180000,
	},
	{
		name: 'Freelance',
		descriptions: ['Freelance payment', 'Consulting', 'Contract work'],
		min: 8000,
		max: 90000,
	},
	{
		name: 'Investments',
		descriptions: ['Dividends', 'Coupon payment', 'Broker transfer'],
		min: 1000,
		max: 25000,
	},
	{
		name: 'Gifts',
		descriptions: ['Gift', 'Cashback', 'Refund'],
		min: 500,
		max: 15000,
	},
];

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (!options.vaultPath) {
		throw new Error('Vault path is required. Pass it as the first positional argument or via --vault.');
	}

	const vaultPath = path.resolve(options.vaultPath);
	const transactionsDir = path.join(vaultPath, 'Finance', 'Transactions');
	await fs.mkdir(transactionsDir, { recursive: true });

	if (options.replaceGenerated) {
		await deleteExistingGeneratedNotes(transactionsDir);
	}

	const generated = buildTransactions({
		count: options.count,
		months: options.months,
		seed: options.seed,
	});

	for (const note of generated) {
		const filePath = path.join(
			transactionsDir,
			String(note.date.getFullYear()),
			String(note.date.getMonth() + 1).padStart(2, '0'),
			note.fileName,
		);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, note.content, 'utf8');
	}

	console.log(`Generated ${generated.length} finance notes in ${transactionsDir}`);
	console.log(`Seed: ${options.seed}`);
}

function parseArgs(args) {
	const options = {
		vaultPath: null,
		count: DEFAULT_COUNT,
		months: DEFAULT_MONTHS,
		seed: 424242,
		replaceGenerated: false,
		help: false,
	};

	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const current = args[index];
		if (current === '--help' || current === '-h') {
			options.help = true;
			continue;
		}
		if (current === '--replace-generated') {
			options.replaceGenerated = true;
			continue;
		}
		if (current === '--vault') {
			options.vaultPath = args[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (current === '--count') {
			options.count = parsePositiveInt(args[index + 1], '--count');
			index += 1;
			continue;
		}
		if (current === '--months') {
			options.months = parsePositiveInt(args[index + 1], '--months');
			index += 1;
			continue;
		}
		if (current === '--seed') {
			options.seed = parsePositiveInt(args[index + 1], '--seed');
			index += 1;
			continue;
		}
		positional.push(current);
	}

	if (!options.vaultPath && positional.length > 0) {
		options.vaultPath = positional[0];
	}
	if (positional.length > 1) {
		options.count = parsePositiveInt(positional[1], 'count');
	}

	return options;
}

function parsePositiveInt(rawValue, label) {
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Invalid ${label}: ${rawValue}`);
	}
	return value;
}

function printHelp() {
	console.log([
		'Generate finance test data for an Obsidian vault.',
		'',
		'Usage:',
		'  node scripts/generate-finance-test-data.mjs <vault-path> <count>',
		'  npm run generate:test-finance-data -- <vault-path> <count>',
		'',
		'Options:',
		'  --vault <path>           Absolute or relative path to target vault',
		'  --count <number>        Total number of generated finance notes',
		'  --months <number>       How many months back to distribute records across (default: 24)',
		'  --seed <number>         Seed for deterministic random generation',
		'  --replace-generated     Delete previously generated notes with the generated-test-data tag',
		'  --help                  Show this help',
	].join('\n'));
}

async function deleteExistingGeneratedNotes(transactionsDir) {
	await deleteGeneratedNotesRecursive(transactionsDir);
}

async function deleteGeneratedNotesRecursive(directoryPath) {
	let entries = [];
	try {
		entries = await fs.readdir(directoryPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			await deleteGeneratedNotesRecursive(filePath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.md')) {
			continue;
		}
		const content = await fs.readFile(filePath, 'utf8');
		if (content.includes(`"${GENERATED_TAG}"`) || content.includes(GENERATED_TAG)) {
			await fs.unlink(filePath);
		}
	}
}

function buildTransactions({ count, months, seed }) {
	const random = mulberry32(seed);
	const startMonth = new Date();
	startMonth.setDate(1);
	startMonth.setHours(0, 0, 0, 0);
	startMonth.setMonth(startMonth.getMonth() - (months - 1));

	const notes = [];
	const usedNames = new Set();
	for (let index = 0; index < count; index += 1) {
		const transaction = createTransaction(index, startMonth, months, random);
		const fileName = createUniqueFileName(transaction, index, usedNames);
		notes.push({
			date: new Date(transaction.dateTime),
			fileName,
			content: renderTransactionNote(transaction),
		});
	}

	return notes;
}

function createTransaction(index, startMonth, months, random) {
	const isIncome = random() < 0.18;
	const monthOffset = Math.floor(random() * months);
	const monthDate = new Date(startMonth.getFullYear(), startMonth.getMonth() + monthOffset, 1);
	const day = 1 + Math.floor(random() * daysInMonth(monthDate));
	const hours = Math.floor(random() * 24);
	const minutes = Math.floor(random() * 60);
	const seconds = Math.floor(random() * 60);
	const timestamp = new Date(
		monthDate.getFullYear(),
		monthDate.getMonth(),
		day,
		hours,
		minutes,
		seconds,
		0,
	);
	const categorySource = isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
	const category = pick(categorySource, random);
	const descriptionBase = pick(category.descriptions, random);
	const amount = roundMoney(randomBetween(category.min, category.max, random));
	const type = isIncome ? 'finance-income' : 'finance-expense';
	const description = `${descriptionBase} ${monthDate.toLocaleString('en-US', { month: 'short' })} ${timestamp.getFullYear()} #${index + 1}`;
	const tags = ['finance', isIncome ? 'income' : 'expense', slugify(category.name), GENERATED_TAG];

	return {
		type,
		status: 'recorded',
		domain: 'finance',
		created: formatDate(timestamp),
		dateTime: timestamp.toISOString(),
		amount,
		currency: 'RUB',
		description,
		category: category.name,
		source: 'manual',
		tags,
	};
}

function createUniqueFileName(transaction, index, usedNames) {
	const date = new Date(transaction.dateTime);
	const datePart = formatDate(date);
	const timePart = [
		String(date.getHours()).padStart(2, '0'),
		String(date.getMinutes()).padStart(2, '0'),
		String(date.getSeconds()).padStart(2, '0'),
	].join('-');
	const typePart = transaction.type === 'finance-income' ? 'inc' : 'exp';
	const amountPart = Math.round(transaction.amount);
	const baseName = `${datePart}-${timePart}-${typePart}-${amountPart}-${slugify(transaction.description).slice(0, 24) || `entry-${index + 1}`}`;

	let attempt = 0;
	while (true) {
		const fileName = attempt === 0 ? `${baseName}.md` : `${baseName}-${attempt}.md`;
		if (!usedNames.has(fileName)) {
			usedNames.add(fileName);
			return fileName;
		}
		attempt += 1;
	}
}

function renderTransactionNote(transaction) {
	const frontmatter = [
		'---',
		`type: "${transaction.type}"`,
		`status: "${transaction.status}"`,
		`domain: "${transaction.domain}"`,
		`created: ${transaction.created}`,
		`dateTime: ${transaction.dateTime}`,
		`amount: ${transaction.amount.toFixed(2)}`,
		`currency: "${transaction.currency}"`,
		`description: "${escapeYamlString(transaction.description)}"`,
		`category: "${escapeYamlString(transaction.category)}"`,
		`source: "${transaction.source}"`,
		`tags: ${JSON.stringify(transaction.tags)}`,
		'---',
		'',
	];
	return frontmatter.join('\n');
}

function escapeYamlString(value) {
	return String(value).replace(/"/g, '\\"');
}

function formatDate(date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0'),
	].join('-');
}

function daysInMonth(date) {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function pick(items, random) {
	return items[Math.floor(random() * items.length)];
}

function randomBetween(min, max, random) {
	return min + (max - min) * random();
}

function roundMoney(value) {
	return Math.round(value * 100) / 100;
}

function slugify(value) {
	return value
		.toLowerCase()
		replace(/[^a-z0-9а-яё]+/gi, '-')
		replace(/^-+|-+$/g, '');
}

function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let result = Math.imul(state ^ (state >>> 15), 1 | state);
		result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
		return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
	};
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
