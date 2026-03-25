import { normalizePath } from 'obsidian';
import { DashboardContributionMode } from '../../settings';
import { IParaCoreApi } from './types';

export function registerFinanceTemplateContributions(
	api: IParaCoreApi,
	transactionsPath: string,
	dashboardMode: DashboardContributionMode = 'interactive',
): void {
	const transactionsFolder = normalizePath(transactionsPath);
	const reportsFolder = normalizePath(transactionsPath.replace(/\/Transactions$/i, '/Reports'));
	const projectSummaryBlock = [
		'### Project Summary',
		'```dataviewjs',
		`const records = dv.pages('"${transactionsFolder}"').where((page) => page.project && String(page.project) === String(dv.current().file.link));`,
		'const expenses = records.where((page) => page.type === "finance-expense");',
		'const incomes = records.where((page) => page.type === "finance-income");',
		'const expenseTotal = expenses.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const incomeTotal = incomes.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const balance = incomeTotal - expenseTotal;',
		'const current = dv.current();',
		'const hasFinanceBudget = Object.prototype.hasOwnProperty.call(current, "finance_budget");',
		'const rawBudget = hasFinanceBudget ? current.finance_budget : current.budget;',
		'const budget = rawBudget === null || rawBudget === undefined || rawBudget === "" ? NaN : Number(rawBudget);',
		'const rows = [',
		'  ["Expenses", expenseTotal.toFixed(2)],',
		'  ["Income", incomeTotal.toFixed(2)],',
		'  ["Balance", balance.toFixed(2)],',
		'  ["Transactions", String(records.length)],',
		'];',
		'if (!Number.isNaN(budget)) {',
		'  const spent = expenseTotal;',
		'  const remaining = budget - spent;',
		'  const usage = budget === 0 ? 0 : (spent / budget) * 100;',
		'  rows.push(["Budget", budget.toFixed(2)]);',
		'  rows.push(["Remaining", remaining.toFixed(2)]);',
		'  rows.push(["Budget used", `${usage.toFixed(1)}%`]);',
		'}',
		'dv.table(["Metric", "Value"], rows);',
		'```',
	].join('\n');

	const areaSummaryBlock = [
		'### Area Summary',
		'```dataviewjs',
		`const records = dv.pages('"${transactionsFolder}"').where((page) => page.area && String(page.area) === String(dv.current().file.link));`,
		'const expenses = records.where((page) => page.type === "finance-expense");',
		'const incomes = records.where((page) => page.type === "finance-income");',
		'const expenseTotal = expenses.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const incomeTotal = incomes.array().reduce((sum, page) => sum + Number(page.amount ?? 0), 0);',
		'const projectCount = new Set(records.array().map((page) => page.project).filter(Boolean).map((value) => String(value))).size;',
		'dv.table(["Metric", "Value"], [',
		'  ["Expenses", expenseTotal.toFixed(2)],',
		'  ["Income", incomeTotal.toFixed(2)],',
		'  ["Balance", (incomeTotal - expenseTotal).toFixed(2)],',
		'  ["Transactions", String(records.length)],',
		'  ["Linked projects", String(projectCount)],',
		']);',
		'```',
	].join('\n');

	api.registerTemplateContribution({
		id: 'finance.project-expenses',
		domainId: 'finance',
		target: 'project',
		slot: 'project.domainViews',
		order: 100,
		render: () => [
			'## Finance',
			'',
			'> Add `finance_budget` to project frontmatter if you want budget tracking here.',
			'',
			projectSummaryBlock,
			'',
			'### Project Expenses',
			'```dataview',
			'TABLE dateTime, amount, currency, category, source',
			`FROM "${transactionsFolder}"`,
			'WHERE type = "finance-expense" AND project = this.file.link',
			'SORT dateTime DESC',
			'```',
			'',
			'### Project Income',
			'```dataview',
			'TABLE dateTime, amount, currency, category, source',
			`FROM "${transactionsFolder}"`,
			'WHERE type = "finance-income" AND project = this.file.link',
			'SORT dateTime DESC',
			'```',
		].join('\n'),
	});

	api.registerTemplateContribution({
		id: 'finance.area-overview',
		domainId: 'finance',
		target: 'area',
		slot: 'area.domainViews',
		order: 100,
		render: () => [
			'## Financial Overview',
			'',
			areaSummaryBlock,
			'',
			'### Area Expenses',
			'```dataview',
			'TABLE dateTime, amount, currency, category, project',
			`FROM "${transactionsFolder}"`,
			'WHERE type = "finance-expense" AND area = this.file.link',
			'SORT dateTime DESC',
			'```',
			'',
			'### Area Income',
			'```dataview',
			'TABLE dateTime, amount, currency, category, project',
			`FROM "${transactionsFolder}"`,
			'WHERE type = "finance-income" AND area = this.file.link',
			'SORT dateTime DESC',
			'```',
		].join('\n'),
	});

	api.registerTemplateContribution({
		id: 'finance.dashboard-current-month-expenses',
		domainId: 'finance',
		target: 'dashboard',
		slot: 'dashboard.domainViews',
		order: 100,
		render: () => buildDashboardContribution(transactionsFolder, reportsFolder, dashboardMode),
	});
}

function buildDashboardContribution(
	transactionsFolder: string,
	reportsFolder: string,
	dashboardMode: DashboardContributionMode,
): string {
	const dashboardBlock = dashboardMode === 'simple'
		? buildSimpleDashboardBlock(transactionsFolder, reportsFolder)
		: buildInteractiveDashboardBlock(transactionsFolder, reportsFolder);

	return [
		'## Finance Dashboard',
		'',
		dashboardBlock,
		'',
		'## Finance reports',
		'```dataview',
		'TABLE periodLabel, periodKind, openingBalance, totalExpenses, totalIncome, closingBalance, budget, budget_alert_level',
		`FROM "${reportsFolder}"`,
		'WHERE type = "finance-report"',
		'SORT periodStart DESC',
		'```',
	].join('\n');
}

function buildInteractiveDashboardBlock(transactionsFolder: string, reportsFolder: string): string {
	return [
		'```dataviewjs',
		`const transactionRecords = dv.pages('"${transactionsFolder}"').where((page) => page.dateTime && (page.type === "finance-expense" || page.type === "finance-income" || page.type === "expense" || page.type === "income"));`,
		`const reportRecords = dv.pages('"${reportsFolder}"').where((page) => String(page.type ?? "") === "finance-report");`,
		'const moment = window.moment;',
		'const state = { month: moment().startOf("month"), year: moment().year() };',
		'const colors = ["#c2410c", "#0f766e", "#7c3aed", "#be123c", "#15803d", "#1d4ed8", "#9333ea", "#ca8a04"];',
		'const formatMoney = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value ?? 0))} RUB`;',
		'const formatShortMoney = (value) => { const amount = Number(value ?? 0); const abs = Math.abs(amount); if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace(/\\.0$/, "")}M`; if (abs >= 1_000) return `${(amount / 1_000).toFixed(1).replace(/\\.0$/, "")}k`; return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(amount); };',
		'const readIsoDate = (value) => { if (!value) return null; if (typeof value === "string") return value.slice(0, 10); if (typeof value.toISO === "function") return value.toISO().slice(0, 10); if (typeof value.toISODate === "function") return value.toISODate(); return String(value).slice(0, 10); };',
		'const monthKeyFromMoment = (value) => `${value.year()}-${value.toDate().toLocaleString("en-US", { month: "short" })}`;',
		'const isExpense = (type) => String(type) === "finance-expense" || String(type) === "expense";',
		'const isIncome = (type) => String(type) === "finance-income" || String(type) === "income";',
		'const levelMeta = { none: { label: "No alerts", tone: "#6b7280", bg: "rgba(107, 114, 128, 0.08)" }, ok: { label: "OK", tone: "#15803d", bg: "rgba(21, 128, 61, 0.10)" }, warning: { label: "Warning", tone: "#c2410c", bg: "rgba(194, 65, 12, 0.10)" }, forecast: { label: "Forecast", tone: "#b45309", bg: "rgba(180, 83, 9, 0.10)" }, critical: { label: "Critical", tone: "#be123c", bg: "rgba(190, 18, 60, 0.10)" } };',
		'const makeButton = (label, action, isActive = false) => `<button data-finance-action="${action}" style="border:1px solid ${isActive ? "var(--interactive-accent)" : "var(--background-modifier-border)"}; background:${isActive ? "var(--interactive-accent-hover)" : "var(--background-secondary)"}; color:var(--text-normal); border-radius:999px; padding:6px 12px; font-size:12px; cursor:pointer;">${label}</button>`;',
		'const makeMetricCard = (label, value) => `<div style="padding:12px 14px; border:1px solid var(--background-modifier-border); border-radius:16px; background:var(--background-secondary);"><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:6px;">${label}</div><div style="font-size:18px; font-weight:600; color:var(--text-normal);">${value}</div></div>`;',
		'const renderAlert = (report) => { if (!report || !report.budget || !report.budget_alert_level || String(report.budget_alert_level) === "none" || String(report.budget_alert_level) === "ok") return ""; const level = String(report.budget_alert_level); const meta = levelMeta[level] ?? levelMeta.none; const usage = report.budget_usage_percentage == null ? "-" : `${Number(report.budget_usage_percentage).toFixed(1)}%`; if (level === "critical") return `<div style="padding:14px 16px; border-radius:18px; background:${meta.bg}; border:1px solid ${meta.tone}; color:${meta.tone};"><div style="font-weight:700; margin-bottom:4px;">Budget alert: ${meta.label}</div><div>Used: ${usage} of ${formatMoney(report.budget)}</div><div>Over budget: ${formatMoney(Math.abs(Number(report.budget_remaining ?? 0)))}</div></div>`; if (level === "forecast") return `<div style="padding:14px 16px; border-radius:18px; background:${meta.bg}; border:1px solid ${meta.tone}; color:${meta.tone};"><div style="font-weight:700; margin-bottom:4px;">Budget alert: ${meta.label}</div><div>Projected month end: ${formatMoney(report.budget_projected_spent ?? 0)}</div><div>Expected overrun: ${formatMoney(Math.max(0, Number(report.budget_projected_delta ?? 0)))}</div></div>`; return `<div style="padding:14px 16px; border-radius:18px; background:${meta.bg}; border:1px solid ${meta.tone}; color:${meta.tone};"><div style="font-weight:700; margin-bottom:4px;">Budget alert: ${meta.label}</div><div>Used: ${usage} of ${formatMoney(report.budget)}</div><div>Remaining: ${formatMoney(report.budget_remaining ?? 0)}</div></div>`; };',
		'const renderMonthlySection = () => { const monthMoment = state.month.clone().startOf("month"); const monthPrefix = monthMoment.format("YYYY-MM"); const reportKey = monthKeyFromMoment(monthMoment); const monthExpenses = transactionRecords.where((page) => isExpense(page.type) && (() => { const isoDate = readIsoDate(page.dateTime); return isoDate && isoDate.slice(0, 7) === monthPrefix; })()).array(); const categories = new Map(); for (const page of monthExpenses) { const key = String(page.category ?? "uncategorized"); categories.set(key, (categories.get(key) ?? 0) + Number(page.amount ?? 0)); } const entries = Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8); const report = reportRecords.where((page) => String(page.periodKind ?? "") === "month" && String(page.periodKey ?? "") === reportKey).array()[0] ?? null; const total = entries.reduce((sum, [, amount]) => sum + amount, 0); const radius = 72; const circumference = 2 * Math.PI * radius; let offset = 0; const segments = entries.map(([label, amount], index) => { const fraction = total === 0 ? 0 : amount / total; const dash = fraction * circumference; const color = colors[index % colors.length]; const segment = `<circle r="${radius}" cx="96" cy="96" fill="transparent" stroke="${color}" stroke-width="36" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 96 96)"></circle>`; offset += dash; return segment; }).join(""); const legend = entries.length === 0 ? `<div style="color:var(--text-muted);">No expenses in this period.</div>` : entries.map(([label, amount], index) => { const percentage = total === 0 ? 0 : (amount / total) * 100; return `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:12px; background:var(--background-secondary); margin-bottom:8px;"><div style="display:flex; align-items:center; gap:8px;"><span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:${colors[index % colors.length]};"></span><span>${label}</span></div><div style="text-align:right; color:var(--text-muted);">${formatMoney(amount)}<br><span style="font-size:11px;">${percentage.toFixed(1)}%</span></div></div>`; }).join(""); const cards = report ? [makeMetricCard("Expenses", formatMoney(report.totalExpenses ?? 0)), makeMetricCard("Income", formatMoney(report.totalIncome ?? 0)), makeMetricCard("Opening", formatMoney(report.openingBalance ?? 0)), makeMetricCard("Closing", formatMoney(report.closingBalance ?? 0)), makeMetricCard("Budget", report.budget != null ? formatMoney(report.budget) : "Not set"), makeMetricCard("Status", (levelMeta[String(report.budget_alert_level ?? "none")] ?? levelMeta.none).label)].join("") : `<div style="color:var(--text-muted);">No monthly report note for this period yet.</div>`; return `<section style="padding:18px; border:1px solid var(--background-modifier-border); border-radius:24px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 90%, white 10%), var(--background-primary)); margin-bottom:18px;"><div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px;"><div><h3 style="margin:0 0 4px 0;">Finance by month</h3><div style="color:var(--text-muted);">${monthMoment.format("MMMM YYYY")}</div></div><div style="display:flex; gap:8px; flex-wrap:wrap;">${makeButton("Prev", "month-prev")}${makeButton("Current", "month-current", monthMoment.isSame(moment(), "month"))}${makeButton("Next", "month-next")}</div></div><div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:14px;">${cards}</div>${renderAlert(report)}<div style="display:grid; grid-template-columns:minmax(200px, 240px) 1fr; gap:18px; align-items:center; margin-top:14px;"><div style="display:flex; justify-content:center;"><svg viewBox="0 0 192 192" width="192" height="192">${segments}<circle r="42" cx="96" cy="96" fill="var(--background-primary)"></circle><text x="96" y="92" text-anchor="middle" font-size="12" fill="var(--text-muted)">Expenses</text><text x="96" y="110" text-anchor="middle" font-size="15" fill="var(--text-normal)">${formatShortMoney(total)}</text></svg></div><div>${legend}</div></div></section>`; };',
		'const renderYearlySection = () => { const year = state.year; const labels = Array.from({ length: 12 }, (_, index) => moment(`${year}-01-01`).add(index, "months").format("MMM")); const expenses = labels.map(() => 0); const incomes = labels.map(() => 0); for (const page of transactionRecords.array()) { const isoDate = readIsoDate(page.dateTime); if (!isoDate || !isoDate.startsWith(`${year}-`)) continue; const monthIndex = Number(isoDate.slice(5, 7)) - 1; if (!Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) continue; if (isIncome(page.type)) incomes[monthIndex] += Number(page.amount ?? 0); else expenses[monthIndex] += Number(page.amount ?? 0); } const maxValue = Math.max(1, ...expenses, ...incomes); const chartHeight = 260; const chartWidth = 820; const paddingLeft = 52; const paddingBottom = 34; const chartTop = 18; const innerHeight = chartHeight - chartTop - paddingBottom; const groupWidth = (chartWidth - paddingLeft - 16) / labels.length; const barWidth = Math.max(10, Math.floor(groupWidth / 3)); const scale = (value) => (value / maxValue) * innerHeight; const gridLines = Array.from({ length: 5 }, (_, step) => { const y = chartTop + innerHeight - (innerHeight / 4) * step; const value = (maxValue / 4) * step; return `<line x1="${paddingLeft}" y1="${y}" x2="${chartWidth - 12}" y2="${y}" stroke="var(--background-modifier-border)" stroke-width="1"></line><text x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${formatShortMoney(value)}</text>`; }).join(""); const bars = labels.map((label, index) => { const baseX = paddingLeft + index * groupWidth + groupWidth / 2; const expenseHeight = scale(expenses[index]); const incomeHeight = scale(incomes[index]); const baseY = chartTop + innerHeight; return `<rect x="${baseX - barWidth - 4}" y="${baseY - expenseHeight}" width="${barWidth}" height="${expenseHeight}" rx="8" ry="8" fill="#d9485f"></rect><rect x="${baseX + 4}" y="${baseY - incomeHeight}" width="${barWidth}" height="${incomeHeight}" rx="8" ry="8" fill="#22a06b"></rect><text x="${baseX}" y="${chartHeight - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${label}</text>`; }).join(""); const yearReports = reportRecords.where((page) => String(page.periodKind ?? "") === "month" && String(page.periodStart ?? "").startsWith(`${year}-`)).array(); const warningMonths = yearReports.filter((page) => String(page.budget_alert_level ?? "") === "warning").length; const forecastMonths = yearReports.filter((page) => String(page.budget_alert_level ?? "") === "forecast").length; const criticalMonths = yearReports.filter((page) => String(page.budget_alert_level ?? "") === "critical").length; const yearlySummary = [makeMetricCard("Expenses", formatMoney(expenses.reduce((sum, value) => sum + value, 0))), makeMetricCard("Income", formatMoney(incomes.reduce((sum, value) => sum + value, 0))), makeMetricCard("Warning months", String(warningMonths)), makeMetricCard("Critical months", String(criticalMonths))].join(""); const alertStrip = (warningMonths || forecastMonths || criticalMonths) ? `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;"><span style="padding:6px 10px; border-radius:999px; background:${levelMeta.warning.bg}; color:${levelMeta.warning.tone};">Warning: ${warningMonths}</span><span style="padding:6px 10px; border-radius:999px; background:${levelMeta.forecast.bg}; color:${levelMeta.forecast.tone};">Forecast: ${forecastMonths}</span><span style="padding:6px 10px; border-radius:999px; background:${levelMeta.critical.bg}; color:${levelMeta.critical.tone};">Critical: ${criticalMonths}</span></div>` : ""; return `<section style="padding:18px; border:1px solid var(--background-modifier-border); border-radius:24px; background:linear-gradient(180deg, color-mix(in srgb, var(--background-primary) 90%, white 8%), var(--background-primary)); margin-bottom:18px;"><div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px;"><div><h3 style="margin:0 0 4px 0;">Finance by year</h3><div style="color:var(--text-muted);">${year}</div></div><div style="display:flex; gap:8px; flex-wrap:wrap;">${makeButton("Prev year", "year-prev")}${makeButton("Current year", "year-current", year === moment().year())}${makeButton("Next year", "year-next")}</div></div><div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:14px;">${yearlySummary}</div>${alertStrip}<div style="margin-top:8px; overflow-x:auto;"><svg viewBox="0 0 ${chartWidth} ${chartHeight}" width="100%" height="${chartHeight}">${gridLines}${bars}</svg><div style="display:flex; gap:16px; margin-top:8px; color:var(--text-muted);"><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#d9485f; margin-right:6px;"></span>Expenses</span><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#22a06b; margin-right:6px;"></span>Income</span></div></div></section>`; };',
		'const wrapper = dv.el("div", "");',
		'const render = () => { wrapper.innerHTML = `${renderMonthlySection()}${renderYearlySection()}`; wrapper.querySelectorAll("[data-finance-action]").forEach((button) => { button.addEventListener("click", () => { const action = button.getAttribute("data-finance-action"); if (action === "month-prev") state.month = state.month.clone().subtract(1, "month").startOf("month"); if (action === "month-current") state.month = moment().startOf("month"); if (action === "month-next") state.month = state.month.clone().add(1, "month").startOf("month"); if (action === "year-prev") state.year -= 1; if (action === "year-current") state.year = moment().year(); if (action === "year-next") state.year += 1; render(); }); }); };',
		'render();',
		'```',
	].join('\n');
}

function buildSimpleDashboardBlock(transactionsFolder: string, reportsFolder: string): string {
	return [
		'```dataviewjs',
		`const transactionRecords = dv.pages('"${transactionsFolder}"').where((page) => page.dateTime && (page.type === "finance-expense" || page.type === "finance-income" || page.type === "expense" || page.type === "income"));`,
		`const reportRecords = dv.pages('"${reportsFolder}"').where((page) => String(page.type ?? "") === "finance-report");`,
		'const moment = window.moment;',
		'const currentMonth = moment().startOf("month");',
		'const currentYear = moment().year();',
		'const colors = ["#c2410c", "#0f766e", "#7c3aed", "#be123c", "#15803d", "#1d4ed8", "#9333ea", "#ca8a04"];',
		'const formatMoney = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value ?? 0))} RUB`;',
		'const formatShortMoney = (value) => { const amount = Number(value ?? 0); const abs = Math.abs(amount); if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace(/\\.0$/, "")}M`; if (abs >= 1_000) return `${(amount / 1_000).toFixed(1).replace(/\\.0$/, "")}k`; return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(amount); };',
		'const readIsoDate = (value) => { if (!value) return null; if (typeof value === "string") return value.slice(0, 10); if (typeof value.toISO === "function") return value.toISO().slice(0, 10); if (typeof value.toISODate === "function") return value.toISODate(); return String(value).slice(0, 10); };',
		'const monthKey = `${currentMonth.year()}-${currentMonth.toDate().toLocaleString("en-US", { month: "short" })}`;',
		'const monthPrefix = currentMonth.format("YYYY-MM");',
		'const monthExpenses = transactionRecords.where((page) => (String(page.type) === "finance-expense" || String(page.type) === "expense") && (() => { const isoDate = readIsoDate(page.dateTime); return isoDate && isoDate.slice(0, 7) === monthPrefix; })()).array();',
		'const monthlyCategories = new Map();',
		'for (const page of monthExpenses) { const key = String(page.category ?? "uncategorized"); monthlyCategories.set(key, (monthlyCategories.get(key) ?? 0) + Number(page.amount ?? 0)); }',
		'const monthEntries = Array.from(monthlyCategories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);',
		'const monthTotal = monthEntries.reduce((sum, [, amount]) => sum + amount, 0);',
		'const monthReport = reportRecords.where((page) => String(page.periodKind ?? "") === "month" && String(page.periodKey ?? "") === monthKey).array()[0] ?? null;',
		'const renderMonthAlert = () => { if (!monthReport || !monthReport.budget || !monthReport.budget_alert_level || String(monthReport.budget_alert_level) === "none" || String(monthReport.budget_alert_level) === "ok") return ""; const level = String(monthReport.budget_alert_level); const tone = level === "critical" ? "#be123c" : level === "forecast" ? "#b45309" : "#c2410c"; const bg = level === "critical" ? "rgba(190,18,60,0.10)" : level === "forecast" ? "rgba(180,83,9,0.10)" : "rgba(194,65,12,0.10)"; const usage = monthReport.budget_usage_percentage == null ? "-" : `${Number(monthReport.budget_usage_percentage).toFixed(1)}%`; const extra = level === "critical" ? `Over budget: ${formatMoney(Math.abs(Number(monthReport.budget_remaining ?? 0)))}` : level === "forecast" ? `Projected month end: ${formatMoney(monthReport.budget_projected_spent ?? 0)}` : `Remaining: ${formatMoney(monthReport.budget_remaining ?? 0)}`; return `<div style="padding:12px 14px; border-radius:16px; border:1px solid ${tone}; background:${bg}; color:${tone}; margin-bottom:12px;"><div style="font-weight:700; margin-bottom:4px;">Budget alert: ${level}</div><div>Used: ${usage} of ${formatMoney(monthReport.budget)}</div><div>${extra}</div></div>`; };',
		'const radius = 70; const circumference = 2 * Math.PI * radius; let offset = 0;',
		'const monthSegments = monthEntries.map(([label, amount], index) => { const fraction = monthTotal === 0 ? 0 : amount / monthTotal; const dash = fraction * circumference; const color = colors[index % colors.length]; const segment = `<circle r="${radius}" cx="92" cy="92" fill="transparent" stroke="${color}" stroke-width="34" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 92 92)"></circle>`; offset += dash; return segment; }).join("");',
		'const monthLegend = monthEntries.length === 0 ? `<div style="color:var(--text-muted);">No expenses this month.</div>` : monthEntries.map(([label, amount], index) => { const percentage = monthTotal === 0 ? 0 : (amount / monthTotal) * 100; return `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:12px; background:var(--background-secondary); margin-bottom:8px;"><div style="display:flex; align-items:center; gap:8px;"><span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:${colors[index % colors.length]};"></span><span>${label}</span></div><div style="text-align:right; color:var(--text-muted);">${formatMoney(amount)}<br><span style="font-size:11px;">${percentage.toFixed(1)}%</span></div></div>`; }).join("");',
		'const labels = Array.from({ length: 12 }, (_, index) => moment(`${currentYear}-01-01`).add(index, "months").format("MMM"));',
		'const expenses = labels.map(() => 0); const incomes = labels.map(() => 0);',
		'for (const page of transactionRecords.array()) { const isoDate = readIsoDate(page.dateTime); if (!isoDate || !isoDate.startsWith(`${currentYear}-`)) continue; const monthIndex = Number(isoDate.slice(5, 7)) - 1; if (!Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) continue; if (String(page.type) === "finance-income" || String(page.type) === "income") incomes[monthIndex] += Number(page.amount ?? 0); else expenses[monthIndex] += Number(page.amount ?? 0); }',
		'const maxValue = Math.max(1, ...expenses, ...incomes);',
		'const chartHeight = 240; const chartWidth = 760; const paddingLeft = 48; const paddingBottom = 30; const chartTop = 16; const innerHeight = chartHeight - chartTop - paddingBottom;',
		'const groupWidth = (chartWidth - paddingLeft - 16) / labels.length; const barWidth = Math.max(10, Math.floor(groupWidth / 3)); const scale = (value) => (value / maxValue) * innerHeight;',
		'const gridLines = Array.from({ length: 5 }, (_, step) => { const y = chartTop + innerHeight - (innerHeight / 4) * step; const value = (maxValue / 4) * step; return `<line x1="${paddingLeft}" y1="${y}" x2="${chartWidth - 12}" y2="${y}" stroke="var(--background-modifier-border)" stroke-width="1"></line><text x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${formatShortMoney(value)}</text>`; }).join("");',
		'const yearBars = labels.map((label, index) => { const baseX = paddingLeft + index * groupWidth + groupWidth / 2; const expenseHeight = scale(expenses[index]); const incomeHeight = scale(incomes[index]); const baseY = chartTop + innerHeight; return `<rect x="${baseX - barWidth - 4}" y="${baseY - expenseHeight}" width="${barWidth}" height="${expenseHeight}" rx="8" ry="8" fill="#d9485f"></rect><rect x="${baseX + 4}" y="${baseY - incomeHeight}" width="${barWidth}" height="${incomeHeight}" rx="8" ry="8" fill="#22a06b"></rect><text x="${baseX}" y="${chartHeight - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${label}</text>`; }).join("");',
		'const wrapper = dv.el("div", "");',
		'wrapper.innerHTML = `<section style="padding:16px; border:1px solid var(--background-modifier-border); border-radius:22px; background:var(--background-primary); margin-bottom:16px;"><div style="margin-bottom:12px;"><h3 style="margin:0 0 4px 0;">Finance this month</h3><div style="color:var(--text-muted);">${currentMonth.format("MMMM YYYY")}</div></div>${renderMonthAlert()}<div style="display:grid; grid-template-columns:minmax(190px, 220px) 1fr; gap:16px; align-items:center;"><div style="display:flex; justify-content:center;"><svg viewBox="0 0 184 184" width="184" height="184">${monthSegments}<circle r="40" cx="92" cy="92" fill="var(--background-primary)"></circle><text x="92" y="88" text-anchor="middle" font-size="12" fill="var(--text-muted)">Expenses</text><text x="92" y="106" text-anchor="middle" font-size="15" fill="var(--text-normal)">${formatShortMoney(monthTotal)}</text></svg></div><div>${monthLegend}</div></div></section><section style="padding:16px; border:1px solid var(--background-modifier-border); border-radius:22px; background:var(--background-primary);"><div style="margin-bottom:12px;"><h3 style="margin:0 0 4px 0;">Finance this year</h3><div style="color:var(--text-muted);">${currentYear}</div></div><div style="overflow-x:auto;"><svg viewBox="0 0 ${chartWidth} ${chartHeight}" width="100%" height="${chartHeight}">${gridLines}${yearBars}</svg><div style="display:flex; gap:16px; margin-top:8px; color:var(--text-muted);"><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#d9485f; margin-right:6px;"></span>Expenses</span><span><span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:#22a06b; margin-right:6px;"></span>Income</span></div></div></section>`;',
		'```',
	].join('\n');
}
