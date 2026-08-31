<script lang="ts">
	/**
	 * Admin → Controls.
	 *
	 * Editing respects the kind split: a `code` control is code in the registry,
	 * so only its label, defaults and enabled flag are editable, and the form
	 * says so instead of offering a prompt box that would do nothing. Prompt and
	 * agent controls are pure data, so all of it is editable, and new ones can
	 * be created without a deploy.
	 */

	interface Control {
		id: string;
		name: string;
		category: string;
		kind: 'code' | 'prompt' | 'agent';
		icon: string | null;
		description: string;
		opName: string | null;
		promptTemplate: string | null;
		systemPrompt: string | null;
		paramsSchema: Record<string, unknown> | null;
		defaultParams: Record<string, unknown> | null;
		builtin: boolean;
		enabled: boolean;
		sortOrder: number;
	}

	interface Props {
		initial: Control[];
	}
	let { initial }: Props = $props();

	// Seeded once per mount; the page reloads the tab when data changes.
	// svelte-ignore state_referenced_locally
	let controls = $state<Control[]>(initial);
	let openId = $state<string | null>(null);
	let draft = $state<{ name: string; category: string; icon: string; description: string; promptTemplate: string; systemPrompt: string; defaultParamsText: string } | null>(null);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let showCreate = $state(false);
	let newControl = $state({
		name: '',
		category: 'Custom',
		kind: 'prompt' as 'prompt' | 'agent',
		description: '',
		promptTemplate: '',
		defaultParamsText: ''
	});

	const byCategory = $derived.by(() => {
		const map = new Map<string, Control[]>();
		for (const c of controls) {
			const list = map.get(c.category) ?? [];
			list.push(c);
			map.set(c.category, list);
		}
		return [...map.entries()];
	});

	function open(c: Control) {
		openId = openId === c.id ? null : c.id;
		if (openId) {
			draft = {
				name: c.name,
				category: c.category,
				icon: c.icon ?? '',
				description: c.description,
				promptTemplate: c.promptTemplate ?? '',
				systemPrompt: c.systemPrompt ?? '',
				defaultParamsText: c.defaultParams ? JSON.stringify(c.defaultParams, null, 2) : ''
			};
		}
	}

	async function post(method: string, body: unknown) {
		busy = true;
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/admin/controls', {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error ?? res.statusText);
			return data;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			return null;
		} finally {
			if (!error) {
				notice = 'Saved.';
				await reload();
			}
			busy = false;
		}
	}

	async function reload() {
		const res = await fetch('/api/admin/controls');
		if (res.ok) controls = (await res.json()).controls;
	}

	async function save(c: Control) {
		if (!draft) return;
		let defaults: unknown;
		try {
			defaults = draft.defaultParamsText.trim() ? JSON.parse(draft.defaultParamsText) : null;
		} catch {
			error = 'Default parameters must be valid JSON.';
			return;
		}
		const r = await post('PATCH', {
			id: c.id,
			patch: {
				name: draft.name,
				category: draft.category,
				icon: draft.icon,
				description: draft.description,
				promptTemplate: c.kind === 'code' ? undefined : draft.promptTemplate,
				systemPrompt: c.kind === 'code' ? undefined : draft.systemPrompt,
				defaultParams: defaults ?? {}
			}
		});
		if (r) openId = null;
	}

	async function toggle(c: Control, enabled: boolean) {
		controls = controls.map((x) => (x.id === c.id ? { ...x, enabled } : x));
		const res = await fetch('/api/admin/controls', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: c.id, patch: { enabled } })
		});
		if (!res.ok) await reload();
	}

	async function remove(c: Control) {
		if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
		await post('DELETE', { id: c.id });
		openId = null;
	}

	async function create() {
		let defaults: unknown;
		try {
			defaults = newControl.defaultParamsText.trim() ? JSON.parse(newControl.defaultParamsText) : null;
		} catch {
			error = 'Default parameters must be valid JSON.';
			return;
		}
		const r = await post('POST', {
			name: newControl.name,
			category: newControl.category,
			kind: newControl.kind,
			description: newControl.description,
			promptTemplate: newControl.promptTemplate,
			defaultParams: defaults ?? {}
		});
		if (r) {
			showCreate = false;
			newControl = { name: '', category: 'Custom', kind: 'prompt', description: '', promptTemplate: '', defaultParamsText: '' };
		}
	}

	const jsonErr = (text: string) => {
		try {
			if (text.trim()) JSON.parse(text);
			return '';
		} catch {
			return 'invalid JSON';
		}
	};
</script>

<p class="hint">
	Free code controls are instant and cost nothing; prompt and agent controls call the model. New
	prompt or agent controls appear in every user's rack as soon as they are created.
</p>

{#if error}<p class="msg err">{error}</p>{/if}
{#if notice}<p class="msg ok">{notice}</p>{/if}

<div class="row">
	<button class="btn primary" onclick={() => (showCreate = !showCreate)}>
		{showCreate ? 'Close' : 'New control'}
	</button>
</div>

{#if showCreate}
	<section class="create">
		<h3>New prompt or agent control</h3>
		<label><span>Name</span><input bind:value={newControl.name} /></label>
		<label><span>Category</span><input bind:value={newControl.category} /></label>
		<label>
			<span>Kind</span>
			<select bind:value={newControl.kind}>
				<option value="prompt">prompt — one model call</option>
				<option value="agent">agent — multi-step loop</option>
		</select>
		</label>
		<label><span>Description</span><input bind:value={newControl.description} /></label>
		<label>
			<span>Prompt template — {'{{param}}'} interpolates from the control's parameters</span>
			<textarea rows="6" bind:value={newControl.promptTemplate}></textarea>
		</label>
		<label>
			<span>Default parameters, JSON (optional)</span>
			<textarea rows="3" bind:value={newControl.defaultParamsText}></textarea>
		</label>
		<button class="btn primary" onclick={create} disabled={busy || !newControl.name.trim() || !newControl.promptTemplate.trim()}>
			Create control
		</button>
	</section>
{/if}

{#each byCategory as [category, list] (category)}
	<section>
		<h3>{category}</h3>
		<ul class="list">
			{#each list as c (c.id)}
				<li>
					<button class="head" onclick={() => open(c)}>
						<span class="icon" aria-hidden="true">{c.icon ?? '·'}</span>
						<span class="name">{c.name}</span>
						<span class="kind kind-{c.kind}">{c.kind}</span>
						{#if !c.enabled}<span class="off">off</span>{/if}
						{#if c.builtin}<span class="tag">built-in</span>{/if}
					</button>

					{#if openId === c.id && draft}
						<div class="edit">
							<label><span>Name</span><input bind:value={draft.name} /></label>
							<label><span>Category</span><input bind:value={draft.category} /></label>
							<label><span>Icon</span><input bind:value={draft.icon} /></label>
							<label><span>Description</span><input bind:value={draft.description} /></label>

							{#if c.kind !== 'code'}
								<label>
									<span>System prompt</span>
									<textarea rows="3" bind:value={draft.systemPrompt}></textarea>
								</label>
								<label>
									<span>Prompt template — {'{{param}}'} interpolates from the control's parameters</span>
									<textarea rows="6" bind:value={draft.promptTemplate}></textarea>
								</label>
							{:else}
								<p class="hint">
									Code control — runs the <code>{c.opName}</code> operation. Its behaviour is
									code, so only the label and defaults can change here.
								</p>
							{/if}

							<label>
								<span>Default parameters, JSON</span>
								<textarea rows="3" bind:value={draft.defaultParamsText}></textarea>
								{#if jsonErr(draft.defaultParamsText)}<span class="err">{jsonErr(draft.defaultParamsText)}</span>{/if}
							</label>

							<div class="actions">
								<label class="check">
									<input
										type="checkbox"
										checked={c.enabled}
										onchange={(e) => toggle(c, e.currentTarget.checked)}
									/>
									<span>Enabled</span>
								</label>
								{#if !c.builtin}
									<button class="btn danger" onclick={() => remove(c)} disabled={busy}>Delete</button>
								{/if}
								<button class="btn primary" onclick={() => save(c)} disabled={busy}>
									{busy ? 'Saving…' : 'Save'}
								</button>
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	.hint {
		margin: 0 0 var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
		line-height: 1.45;
	}
	.row {
		display: flex;
		justify-content: flex-end;
		margin-bottom: var(--space-2);
	}
	.create,
	section {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-bottom: var(--space-3);
	}
	section h3 {
		font-size: var(--text-xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin: 0 0 var(--space-2);
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.head {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		background: none;
		border: none;
		color: var(--fg);
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		font-size: var(--text-sm);
		text-align: left;
	}
	.head:hover {
		background: var(--bg-raise);
	}
	.icon {
		color: var(--accent);
		width: 1.2em;
		text-align: center;
	}
	.name {
		flex: 1;
	}
	.kind {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--fg-dim);
	}
	.kind-code {
		color: var(--diff-add);
	}
	.off,
	.tag {
		font-size: 0.6rem;
		text-transform: uppercase;
		color: var(--fg-dim);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0 4px;
	}
	.edit {
		padding: var(--space-2);
		background: var(--bg-raise);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin: var(--space-1) 0;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-bottom: var(--space-2);
	}
	label.check {
		flex-direction: row;
		align-items: center;
		margin-bottom: 0;
	}
	input,
	select,
	textarea {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
		font-family: inherit;
	}
	textarea {
		font-family: var(--font-mono, monospace);
		resize: vertical;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		justify-content: flex-end;
	}
	.actions .check {
		margin-right: auto;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		font-size: var(--text-xs);
		border-radius: var(--radius);
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn.danger {
		background: var(--danger);
		color: var(--bg);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.err {
		color: var(--danger);
		font-size: var(--text-xs);
	}
	code {
		font-family: var(--font-mono, monospace);
	}
</style>
