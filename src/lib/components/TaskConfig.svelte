<script lang="ts">
	import { untrack } from 'svelte';
	import { REASONING_EFFORTS } from '$lib/ai/config';
	import type { CoreTask, TaskOptions } from '$lib/ai/config';

	/**
	 * One task's model and reasoning settings.
	 *
	 * Kept per task rather than global because melody's jobs are not alike:
	 * naming a piece wants speed, orchestrating wants the most careful model
	 * available, and paying the same rate for both is how a self-hosted
	 * instance ends up with a surprising bill.
	 */

	interface ModelOption {
		modelKey: string;
		displayName: string;
		supportsTools: boolean;
		enabled: boolean;
	}

	interface TaskView {
		task: CoreTask;
		systemPrompt: string;
		primaryModelId: string | null;
		backupModelId: string | null;
		options: TaskOptions;
		versionCount: number;
	}

	interface Props {
		task: TaskView;
		blurb: string;
		models: ModelOption[];
		/** Used when the task names no model of its own. */
		fallbackModel: string;
		busy: boolean;
		onsave: (patch: Partial<TaskView> & { task: CoreTask }) => Promise<void>;
		onhistory: (task: CoreTask) => Promise<void>;
	}
	let { task, blurb, models, fallbackModel, busy, onsave, onhistory }: Props = $props();

	let open = $state(false);
	// untrack makes "seed once from the prop" explicit; the effect below owns
	// re-seeding, and without it Svelte warns that only the initial value is read.
	let draft = $state(untrack(() => ({ ...task, options: { ...task.options } })));
	let dirty = $derived(JSON.stringify(draft) !== JSON.stringify(task));

	// Re-seed when the parent reloads after a save, but never while the panel is
	// open and edited — that would silently discard what is being typed.
	$effect(() => {
		if (!dirty) draft = { ...task, options: { ...task.options } };
	});

	// Only tool-capable models can drive the ops registry. A model without tool
	// support cannot edit a score at all, and fails in a way that reads as the
	// model ignoring instructions rather than as a configuration mistake.
	const usable = $derived(models.filter((m) => m.enabled && m.supportsTools));

	const effective = $derived(draft.primaryModelId || fallbackModel || 'none selected');

	function setOption<K extends keyof TaskOptions>(key: K, value: TaskOptions[K]) {
		draft = { ...draft, options: { ...draft.options, [key]: value } };
	}
</script>

<div class="task" class:open>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
		<span class="name">{draft.task}</span>
		<span class="model" class:inherited={!draft.primaryModelId}>{effective}</span>
		{#if draft.options.effort}<span class="pill">{draft.options.effort}</span>{/if}
		{#if dirty}<span class="pill warn">unsaved</span>{/if}
	</button>

	{#if open}
		<div class="body">
			<p class="hint">{blurb}</p>

			<div class="grid">
				<label>
					<span>Model</span>
					<select
						value={draft.primaryModelId ?? ''}
						onchange={(e) => (draft = { ...draft, primaryModelId: e.currentTarget.value || null })}
					>
						<option value="">Use the default ({fallbackModel || 'none set'})</option>
						{#each usable as m (m.modelKey)}
							<option value={m.modelKey}>{m.displayName || m.modelKey}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>Backup</span>
					<select
						value={draft.backupModelId ?? ''}
						onchange={(e) => (draft = { ...draft, backupModelId: e.currentTarget.value || null })}
					>
						<option value="">None</option>
						{#each usable as m (m.modelKey)}
							<option value={m.modelKey}>{m.displayName || m.modelKey}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>Reasoning</span>
					<select
						value={draft.options.reasoning ?? 'hidden'}
						onchange={(e) =>
							setOption('reasoning', e.currentTarget.value as TaskOptions['reasoning'])}
					>
						<option value="off">Off — fastest</option>
						<option value="hidden">On, not returned</option>
						<option value="on">On, returned</option>
					</select>
				</label>

				<label>
					<span>Effort</span>
					<select
						value={draft.options.effort ?? 'medium'}
						disabled={draft.options.reasoning === 'off'}
						onchange={(e) => setOption('effort', e.currentTarget.value as TaskOptions['effort'])}
					>
						{#each REASONING_EFFORTS as level (level)}
							<option value={level}>{level}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>Max tokens</span>
					<input
						type="number"
						min="64"
						step="256"
						value={draft.options.maxTokens ?? ''}
						placeholder="default"
						onchange={(e) =>
							setOption('maxTokens', e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}
					/>
				</label>
			</div>

			<label class="prompt">
				<span>System prompt <em>{draft.systemPrompt ? '' : 'using the built-in default'}</em></span>
				<textarea
					rows="6"
					value={draft.systemPrompt}
					placeholder="Leave blank to use melody's built-in prompt for this task."
					onchange={(e) => (draft = { ...draft, systemPrompt: e.currentTarget.value })}
				></textarea>
			</label>

			<div class="actions">
				{#if task.versionCount > 0}
					<button class="btn" onclick={() => onhistory(task.task)} disabled={busy}>
						History ({task.versionCount})
					</button>
				{/if}
				<div class="spacer"></div>
				<button
					class="btn"
					onclick={() => (draft = { ...task, options: { ...task.options } })}
					disabled={!dirty || busy}
				>
					Revert
				</button>
				<button class="btn primary" onclick={() => onsave(draft)} disabled={!dirty || busy}>
					Save
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.task {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-pane);
	}
	.open {
		border-color: var(--accent);
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		text-align: left;
		font-size: var(--text-sm);
	}
	.caret {
		color: var(--fg-dim);
		flex: none;
	}
	.name {
		font-weight: 600;
		flex: none;
	}
	.model {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.inherited {
		font-style: italic;
		opacity: 0.75;
	}
	.pill {
		flex: none;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 1px var(--space-2);
		border-radius: 999px;
		background: var(--border);
		color: var(--fg-dim);
	}
	.warn {
		background: var(--diff-change);
		color: var(--bg);
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: 0 var(--space-3) var(--space-3);
		border-top: 1px solid var(--border);
		padding-top: var(--space-3);
	}
	.hint {
		margin: 0;
		color: var(--fg-dim);
		font-size: var(--text-xs);
		line-height: 1.5;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--space-2);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		min-width: 0;
	}
	label em {
		font-style: normal;
		opacity: 0.7;
	}
	select,
	input,
	textarea {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 6px;
		font-size: var(--text-xs);
		min-width: 0;
		width: 100%;
	}
	textarea {
		resize: vertical;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		line-height: 1.5;
	}
	select:disabled {
		opacity: 0.5;
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.spacer {
		flex: 1;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
		font-size: var(--text-xs);
		border-radius: var(--radius);
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
