import { ReportPeriodDescriptor, ReportPeriodKind } from '../types';

const DAY_END_HOURS = 23;
const DAY_END_MINUTES = 59;
const DAY_END_SECONDS = 59;
const DAY_END_MILLISECONDS = 999;

export function normalizePeriodStart(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function normalizePeriodEnd(date: Date): Date {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		DAY_END_HOURS,
		DAY_END_MINUTES,
		DAY_END_SECONDS,
		DAY_END_MILLISECONDS,
	);
}

export function getPeriodDescriptorForDate(
	kind: Exclude<ReportPeriodKind, 'custom'>,
	date: Date,
): ReportPeriodDescriptor {
	const year = date.getFullYear();
	const month = date.getMonth();
	const shortMonth = new Date(year, month, 1).toLocaleString('en-US', { month: 'short' });

	if (kind === 'month') {
		const startDate = new Date(year, month, 1);
		const endDate = new Date(year, month + 1, 0, DAY_END_HOURS, DAY_END_MINUTES, DAY_END_SECONDS, DAY_END_MILLISECONDS);
		return {
			kind,
			key: `${year}-${shortMonth}`,
			label: startDate.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
			startDate,
			endDate,
		};
	}

	if (kind === 'quarter') {
		const quarterIndex = Math.floor(month / 3);
		const startMonth = quarterIndex * 3;
		const quarter = quarterIndex + 1;
		const startDate = new Date(year, startMonth, 1);
		const endDate = new Date(year, startMonth + 3, 0, DAY_END_HOURS, DAY_END_MINUTES, DAY_END_SECONDS, DAY_END_MILLISECONDS);
		return {
			kind,
			key: `${year}-Q${quarter}`,
			label: `Q${quarter} ${year}`,
			startDate,
			endDate,
		};
	}

	if (kind === 'half-year') {
		const half = month < 6 ? 1 : 2;
		const startMonth = half === 1 ? 0 : 6;
		const startDate = new Date(year, startMonth, 1);
		const endDate = new Date(year, startMonth + 6, 0, DAY_END_HOURS, DAY_END_MINUTES, DAY_END_SECONDS, DAY_END_MILLISECONDS);
		return {
			kind,
			key: `${year}-H${half}`,
			label: `H${half} ${year}`,
			startDate,
			endDate,
		};
	}

	const startDate = new Date(year, 0, 1);
	const endDate = new Date(year, 12, 0, DAY_END_HOURS, DAY_END_MINUTES, DAY_END_SECONDS, DAY_END_MILLISECONDS);
	return {
		kind: 'year',
		key: `${year}`,
		label: `${year}`,
		startDate,
		endDate,
	};
}

export function createCustomPeriodDescriptor(startDate: Date, endDate: Date): ReportPeriodDescriptor {
	const normalizedStart = normalizePeriodStart(startDate);
	const normalizedEnd = normalizePeriodEnd(endDate);
	return {
		kind: 'custom',
		key: `${formatDateKey(normalizedStart)}_${formatDateKey(normalizedEnd)}`,
		label: `${formatDateKey(normalizedStart)} to ${formatDateKey(normalizedEnd)}`,
		startDate: normalizedStart,
		endDate: normalizedEnd,
	};
}

export function getEnabledAutoPeriodKinds(settings: {
	autoMonthlyReports: boolean;
	autoQuarterlyReports: boolean;
	autoHalfYearReports: boolean;
	autoYearlyReports: boolean;
}): Array<Exclude<ReportPeriodKind, 'custom'>> {
	const kinds: Array<Exclude<ReportPeriodKind, 'custom'>> = [];
	if (settings.autoMonthlyReports) {
		kinds.push('month');
	}
	if (settings.autoQuarterlyReports) {
		kinds.push('quarter');
	}
	if (settings.autoHalfYearReports) {
		kinds.push('half-year');
	}
	if (settings.autoYearlyReports) {
		kinds.push('year');
	}
	return kinds;
}

export function enumeratePeriodsInRange(
	kind: Exclude<ReportPeriodKind, 'custom'>,
	startDate: Date,
	endDate: Date,
	includeCurrentPeriod = true,
): ReportPeriodDescriptor[] {
	const descriptors: ReportPeriodDescriptor[] = [];
	const startDescriptor = getPeriodDescriptorForDate(kind, startDate);
	const finalDescriptor = getPeriodDescriptorForDate(kind, endDate);
	let cursor = new Date(startDescriptor.startDate);

	while (cursor.getTime() <= finalDescriptor.startDate.getTime()) {
		descriptors.push(getPeriodDescriptorForDate(kind, cursor));
		cursor = advanceCursor(kind, cursor);
	}

	if (
		includeCurrentPeriod &&
		descriptors.length === 0
	) {
		descriptors.push(getPeriodDescriptorForDate(kind, new Date()));
	}

	return descriptors;
}

export function sortPeriodDescriptors(descriptors: ReportPeriodDescriptor[]): ReportPeriodDescriptor[] {
	return descriptors
		.slice()
		.sort((left, right) => left.startDate.getTime() - right.startDate.getTime());
}

export function formatDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function formatPeriodTitle(descriptor: ReportPeriodDescriptor): string {
	if (descriptor.kind === 'custom') {
		return `Financial Report ${formatDateKey(descriptor.startDate)} to ${formatDateKey(descriptor.endDate)}`;
	}
	return `Financial Report ${descriptor.label}`;
}

function advanceCursor(kind: Exclude<ReportPeriodKind, 'custom'>, cursor: Date): Date {
	if (kind === 'month') {
		return new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
	}
	if (kind === 'quarter') {
		return new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1);
	}
	if (kind === 'half-year') {
		return new Date(cursor.getFullYear(), cursor.getMonth() + 6, 1);
	}
	return new Date(cursor.getFullYear() + 1, 0, 1);
}
