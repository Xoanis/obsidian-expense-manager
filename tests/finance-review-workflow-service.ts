import * as assert from 'node:assert/strict';

import { FinanceReviewWorkflowService } from '../src/services/finance-review-workflow-service';

function run(name: string, fn: () => Promise<void> | void): Promise<void> {
	return Promise.resolve()
		.then(() => fn())
		.then(() => {
			console.log(`PASS ${name}`);
		})
		.catch((error) => {
			console.error(`FAIL ${name}`);
			throw error;
		});
}

export default async function main(): Promise<void> {
	await run('archives rejected stored review items when retention is enabled', async () => {
		const file = { path: 'Expenses/2026/04/sample.md' } as any;
		let archivedFilePath: string | null = null;
		let deletedFilePath: string | null = null;

		const workflowService = new FinanceReviewWorkflowService(
			{
				async archiveTransactionAsRejected(targetFile: { path: string }) {
					archivedFilePath = targetFile.path;
					return { path: 'Expenses/Archive/Rejected/2026/04/sample.md' } as any;
				},
				async deleteTransaction(targetFile: { path: string }) {
					deletedFilePath = targetFile.path;
				},
			} as any,
			() => ({ archiveRejectedTransactions: true }),
		);

		const result = await workflowService.rejectStoredReviewItem(file);

		assert.equal(result.disposition, 'archived');
		assert.equal(result.file?.path, 'Expenses/Archive/Rejected/2026/04/sample.md');
		assert.equal(archivedFilePath, file.path);
		assert.equal(deletedFilePath, null);
	});

	await run('deletes rejected stored review items when retention is disabled', async () => {
		const file = { path: 'Expenses/2026/04/sample.md' } as any;
		let archived = false;
		let deletedFilePath: string | null = null;

		const workflowService = new FinanceReviewWorkflowService(
			{
				async archiveTransactionAsRejected() {
					archived = true;
					return file;
				},
				async deleteTransaction(targetFile: { path: string }) {
					deletedFilePath = targetFile.path;
				},
			} as any,
			() => ({ archiveRejectedTransactions: false }),
		);

		const result = await workflowService.rejectStoredReviewItem(file);

		assert.equal(result.disposition, 'deleted');
		assert.equal(result.file, undefined);
		assert.equal(archived, false);
		assert.equal(deletedFilePath, file.path);
	});
}
