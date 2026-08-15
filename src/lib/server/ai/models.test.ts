import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel, searchModels, syncModels, setModelEnabled } from './models.js';
import { runMigrations } from '../db/index.js';

/**
 * Catalogue parsing gets the detailed coverage: it turns a vendor payload into
 * the numbers a cost display and a capability filter both depend on, and every
 * field in it is optional in practice.
 */

describe('parseModel', () => {
	const full = {
		id: 'anthropic/claude-opus-5',
		name: 'Claude Opus 5',
		context_length: 1_000_000,
		pricing: { prompt: '0.000005', completion: '0.000025' },
		architecture: { input_modalities: ['text', 'image'] },
		supported_parameters: ['tools', 'structured_outputs', 'reasoning']
	};

	it('converts per-token price strings to price per million', () => {
		const m = parseModel(full)!;
		expect(m.promptCostPerMTok).toBeCloseTo(5);
		expect(m.completionCostPerMTok).toBeCloseTo(25);
	});

	it('reads capability from supported_parameters and modalities', () => {
		const m = parseModel(full)!;
		expect(m.supportsTools).toBe(true);
		expect(m.supportsVision).toBe(true);
	});

	it('marks a model without tools as such, so the picker can hide it', () => {
		const m = parseModel({ ...full, supported_parameters: ['reasoning'] })!;
		expect(m.supportsTools).toBe(false);
	});

	it('marks a text-only model as not supporting vision', () => {
		const m = parseModel({ ...full, architecture: { input_modalities: ['text'] } })!;
		expect(m.supportsVision).toBe(false);
	});

	it('falls back to the id when there is no display name', () => {
		expect(parseModel({ id: 'x/y' })!.displayName).toBe('x/y');
	});

	it('survives a payload missing everything optional', () => {
		expect(parseModel({ id: 'x/y' })).toEqual({
			modelKey: 'x/y',
			displayName: 'x/y',
			contextWindow: null,
			supportsTools: false,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null
		});
	});

	it('rejects an entry with no id', () => {
		expect(parseModel({ name: 'nameless' })).toBeNull();
		expect(parseModel({ id: '' })).toBeNull();
	});

	it('treats unparseable pricing as unknown rather than zero', () => {
		// Zero would read as "this model is free", which is worse than blank.
		const m = parseModel({ id: 'x/y', pricing: { prompt: 'n/a', completion: undefined } })!;
		expect(m.promptCostPerMTok).toBeNull();
		expect(m.completionCostPerMTok).toBeNull();
	});

	it('accepts numeric pricing as well as strings', () => {
		const m = parseModel({ id: 'x/y', pricing: { prompt: 0.000002, completion: 0.00001 } })!;
		expect(m.promptCostPerMTok).toBeCloseTo(2);
	});
});

describe('syncModels', () => {
	beforeAll(() => runMigrations());

	const provider = 'prov-test';
	const model = (key: string, over: Partial<ReturnType<typeof parseModel>> = {}) => ({
		modelKey: key,
		displayName: key,
		contextWindow: 200_000,
		supportsTools: true,
		supportsVision: false,
		promptCostPerMTok: 1,
		completionCostPerMTok: 2,
		...over
	});

	it('adds new models disabled, so the list stays curated', () => {
		const result = syncModels(provider, [model('a/one'), model('a/two')]);
		expect(result).toEqual({ added: 2, updated: 0, total: 2 });
		expect(searchModels({ providerId: provider }).every((m) => !m.enabled)).toBe(true);
	});

	it('updates metadata on a second sync without re-adding', () => {
		const result = syncModels(provider, [model('a/one', { displayName: 'Renamed' })]);
		expect(result.added).toBe(0);
		expect(result.updated).toBe(1);
		expect(searchModels({ providerId: provider }).find((m) => m.modelKey === 'a/one')!.displayName).toBe(
			'Renamed'
		);
	});

	it('never re-disables a model the user enabled', () => {
		const row = searchModels({ providerId: provider }).find((m) => m.modelKey === 'a/one')!;
		setModelEnabled(row.id, true);

		syncModels(provider, [model('a/one', { displayName: 'Renamed again' })]);

		const after = searchModels({ providerId: provider }).find((m) => m.modelKey === 'a/one')!;
		expect(after.enabled).toBe(true);
		expect(after.displayName).toBe('Renamed again');
	});
});

describe('searchModels', () => {
	beforeAll(() => runMigrations());
	const provider = 'prov-search';

	beforeAll(() => {
		syncModels(provider, [
			{
				modelKey: 'anthropic/claude-opus-5',
				displayName: 'Claude Opus 5',
				contextWindow: 1_000_000,
				supportsTools: true,
				supportsVision: true,
				promptCostPerMTok: 5,
				completionCostPerMTok: 25
			},
			{
				modelKey: 'someone/no-tools',
				displayName: 'Toolless',
				contextWindow: 8000,
				supportsTools: false,
				supportsVision: false,
				promptCostPerMTok: 0.1,
				completionCostPerMTok: 0.2
			}
		]);
	});

	it('hides models that cannot call tools by default', () => {
		const keys = searchModels({ providerId: provider }).map((m) => m.modelKey);
		expect(keys).toContain('anthropic/claude-opus-5');
		expect(keys).not.toContain('someone/no-tools');
	});

	it('can be asked for everything', () => {
		const keys = searchModels({ providerId: provider, toolsOnly: false }).map((m) => m.modelKey);
		expect(keys).toContain('someone/no-tools');
	});

	it('matches on slug or display name', () => {
		expect(searchModels({ providerId: provider, query: 'opus' })).toHaveLength(1);
		expect(searchModels({ providerId: provider, query: 'Claude' })).toHaveLength(1);
		expect(searchModels({ providerId: provider, query: 'zzz' })).toHaveLength(0);
	});

	it('is case-insensitive', () => {
		expect(searchModels({ providerId: provider, query: 'OPUS' })).toHaveLength(1);
	});

	it('honours the limit', () => {
		expect(searchModels({ providerId: provider, toolsOnly: false, limit: 1 })).toHaveLength(1);
	});
});
