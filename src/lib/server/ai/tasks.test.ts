import { describe, it, expect, beforeAll } from 'vitest';
import { listPromptVersions, listTasks, restorePromptVersion, saveTask } from './tasks.js';
import { runMigrations } from '../db/index.js';
import { CORE_TASKS } from '../db/schema.js';

/**
 * Per-task configuration is what stops one global model setting billing opus
 * rates to generate a title. The rules worth pinning down are the ones that are
 * easy to get subtly wrong: what counts as a change worth versioning, and what
 * an empty selection means.
 */

beforeAll(() => runMigrations());

describe('listTasks', () => {
	it('returns a row for every core task, configured or not', () => {
		const tasks = listTasks();
		expect(tasks.map((t) => t.task).sort()).toEqual([...CORE_TASKS].sort());
	});
});

describe('saveTask', () => {
	it('stores a model choice and reads it back', () => {
		const saved = saveTask({ task: 'title', primaryModelId: 'openai/gpt-5-mini' });
		expect(saved.primaryModelId).toBe('openai/gpt-5-mini');
		expect(listTasks().find((t) => t.task === 'title')?.primaryModelId).toBe('openai/gpt-5-mini');
	});

	it('treats an empty string as "fall back to the default"', () => {
		saveTask({ task: 'analyse', primaryModelId: 'x/y' });
		const cleared = saveTask({ task: 'analyse', primaryModelId: '' });
		// null, not '': resolveTask tests truthiness, and an empty string stored
		// as a model would read as a configured choice of nothing.
		expect(cleared.primaryModelId).toBeNull();
	});

	it('clamps max tokens and drops values it does not recognise', () => {
		const saved = saveTask({
			task: 'orchestrate',
			options: {
				maxTokens: 999_999,
				effort: 'nonsense' as never,
				reasoning: 'sideways' as never
			}
		});
		expect(saved.options.maxTokens).toBe(200_000);
		expect(saved.options.effort).toBeUndefined();
		expect(saved.options.reasoning).toBeUndefined();
	});

	it('rejects a task name that is not a core task', () => {
		expect(() => saveTask({ task: 'not_a_task' as never })).toThrow(/Unknown task/);
	});
});

describe('prompt versions', () => {
	it('records a version when the prompt changes', () => {
		saveTask({ task: 'compose_plan', systemPrompt: 'first', author: 'ann' });
		saveTask({ task: 'compose_plan', systemPrompt: 'second', author: 'ann' });

		const versions = listPromptVersions('compose_plan');
		expect(versions.map((v) => v.systemPrompt)).toEqual(['second', 'first']);
	});

	it('does not record one when only the model changes', () => {
		const before = listPromptVersions('compose_plan').length;
		saveTask({ task: 'compose_plan', primaryModelId: 'some/model' });
		expect(listPromptVersions('compose_plan')).toHaveLength(before);
	});

	it('does not record one when the prompt is saved unchanged', () => {
		const before = listPromptVersions('compose_plan').length;
		saveTask({ task: 'compose_plan', systemPrompt: 'second' });
		expect(listPromptVersions('compose_plan')).toHaveLength(before);
	});

	it('restores forward, so the reverted-from text is still recoverable', () => {
		const versions = listPromptVersions('compose_plan');
		const oldest = versions[versions.length - 1];

		const restored = restorePromptVersion('compose_plan', oldest.id, 'bob');
		expect(restored.systemPrompt).toBe('first');

		// The restore is itself a new version, so 'second' has not been lost.
		const after = listPromptVersions('compose_plan');
		expect(after[0].systemPrompt).toBe('first');
		expect(after.some((v) => v.systemPrompt === 'second')).toBe(true);
	});

	it('refuses a version id from another task', () => {
		saveTask({ task: 'analyse', systemPrompt: 'analyse prompt', author: 'ann' });
		const other = listPromptVersions('analyse')[0];
		expect(() => restorePromptVersion('compose_plan', other.id, 'bob')).toThrow(/no longer exists/);
	});
});
