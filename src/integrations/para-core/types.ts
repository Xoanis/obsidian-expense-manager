import { TFile } from 'obsidian';

export type TemplateTarget =
  | 'project'
  | 'area'
  | 'resource'
  | 'daily'
  | 'dashboard'
  | 'review'
  | 'guideline';

export interface TemplateContributionContext {
  target: TemplateTarget;
  slot: string;
}

export interface TemplateContribution {
  id: string;
  domainId: string;
  target: TemplateTarget;
  slot: string;
  order?: number;
  render: (context: TemplateContributionContext) => string;
}

export type TelegramCardTarget = 'project' | 'area';

export type MetadataContributionTarget = 'project' | 'area' | 'resource' | 'daily';

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export type TelegramInlineKeyboard = TelegramInlineButton[][];

export interface TelegramCardContributionContext {
  target: TelegramCardTarget;
  path: string;
  page: number;
}

export interface TelegramCardContribution {
  id: string;
  domainId: string;
  target: TelegramCardTarget;
  order?: number;
  renderSection?: (
    context: TelegramCardContributionContext,
  ) => Promise<string | null> | string | null;
  buildInlineKeyboard?: (
    context: TelegramCardContributionContext,
  ) => Promise<TelegramInlineKeyboard | null | undefined> | TelegramInlineKeyboard | null | undefined;
}

export interface MetadataContributionContext {
  target: MetadataContributionTarget;
  path?: string;
  page?: number;
}

export interface MetadataContribution {
  id: string;
  domainId: string;
  target: MetadataContributionTarget;
  order?: number;
  frontmatterDefaults?:
    | Record<string, unknown>
    | ((context: MetadataContributionContext) => Record<string, unknown> | null | undefined);
  renderMetadataLines?:
    | ((
        context: MetadataContributionContext,
      ) => Promise<string | string[] | null | undefined> | string | string[] | null | undefined);
  buildInlineKeyboard?:
    | ((
        context: MetadataContributionContext,
      ) => Promise<TelegramInlineKeyboard | null | undefined> | TelegramInlineKeyboard | null | undefined);
}

export interface TemplateContext<TFrontmatter = Record<string, unknown>> {
  title: string;
  date: string;
  timestamp: string;
  frontmatter: TFrontmatter;
}

export interface NoteTypeDefinition<TFrontmatter = Record<string, unknown>> {
  type: string;
  displayName: string;
  folderKey: string;
  fileNameStrategy?: 'title' | 'date';
  requiredFields: string[];
  allowedStatuses: readonly string[];
  defaultFrontmatter: (date: string, timestamp: string) => TFrontmatter;
  template: (ctx: TemplateContext<TFrontmatter>) => string;
}

export interface CreateNoteOptions {
  type: string;
  title: string;
  folderOverride?: string;
  frontmatterOverrides?: Record<string, unknown>;
  openAfterCreate?: boolean;
  fileNameOverride?: string;
}

export interface ParaDomainRegistration {
  id: string;
  displayName: string;
  recordsPath: string;
  noteTypes?: NoteTypeDefinition[];
}

export interface RegisteredParaDomain {
  id: string;
  displayName: string;
  recordsPath: string;
  noteTypeIds: string[];
}

export interface IParaCoreApi {
  registerDomain(definition: ParaDomainRegistration): RegisteredParaDomain;
  registerTemplateContribution(contribution: TemplateContribution): void;
  registerMetadataContribution(contribution: MetadataContribution): void;
  registerTelegramCardContribution(contribution: TelegramCardContribution): void;
  createNote(options: CreateNoteOptions): Promise<TFile>;
  getDomainRecordsPath(domainId: string): string | null;
}
