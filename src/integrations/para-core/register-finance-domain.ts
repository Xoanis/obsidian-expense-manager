import { getFinanceNoteTypes } from './finance-note-types';
import { IParaCoreApi, RegisteredParaDomain } from './types';

export function registerFinanceDomain(api: IParaCoreApi): RegisteredParaDomain {
	return api.registerDomain({
		id: 'finance',
		displayName: 'Finance',
		recordsPath: 'Finance',
		noteTypes: getFinanceNoteTypes(),
	});
}
