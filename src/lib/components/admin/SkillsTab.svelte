<script lang="ts">
	/**
	 * Admin → Skills.
	 *
	 * The file is the truth and the body is read at prompt time, so a save takes
	 * effect on the very next AI call with no restart — the panel just edits the
	 * file and lets the index catch up.
	 */

	interface Skill {
		id: string;
		name: string;
		category: string;
		summary: string;
		enabled: boolean;
		updatedAt: number;
	}

	interface Props {
		initial: Skill[];
	}
	let { initial }: Props = $props();

	// Seeded once per mount; the page reloads the tab when data changes.
	// svelte-ignore state_referenced_locally
	let skills = $state<Skill[]>(initial);
	let editingId = $state<string | null>(null);
	let body = $state('');
	let dirty = $state(false);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let showCreate = $state(false);
	let newSkill = $state({ name: '', category: 'style', body: '' });

	const editing = $derived(skills.find((s) => s.id === editingId) ?? null);

	async function reload() {
		const res = await fetch('/api/admin/skills');
		if (res.ok) skills = (await res.json()).skills;
	}

	async function open(s: Skill) {
		if (dirty && !confirm('Discard unsaved changes?')) return;
		error = '';
		notice = '';
		try {
			const res = await fetch(`/api/admin/skills?id=${encodeURIComponent(s.id)}`);
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			body = (await res.json()).skill.body;
			editingId = s.id;
			dirty = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	function close() {
		editingId = null;
		dirty = false;
	}

	async function save() {
		if (!editingId) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/admin/skills', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: editingId, body })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error ?? res.statusText);
			await reload();
			editingId = null;
			dirty = false;
			notice = 'Saved — the next AI call picks it up.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function toggle(s: Skill, enabled: boolean) {
		skills = skills.map((x) => (x.id === s.id ? { ...x, enabled } : x));
		const res = await fetch('/api/admin/skills', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: s.id, enabled })
		});
		if (!res.ok) await reload();
	}

	async function remove(s: Skill) {
		if (!confirm(`Delete "${s.name}"? The markdown file goes with it.`)) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/admin/skills', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: s.id })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			if (editingId === s.id) close();
			await reload();
			notice = 'Deleted.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function create() {
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/admin/skills', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(newSkill)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error ?? res.statusText);
			showCreate = false;
			newSkill = { name: '', category: 'style', body: '' };
			await reload();
			notice = 'Created.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<p class="hint">
	Style skills are markdown notes the AI reads before answering a style request. Editing one takes
	effect on the next call — no restart. Disabling hides it from matching without deleting it.
</p>

{#if error}<p class="msg err">{error}</p>{/if}
{#if notice}<p class="msg ok">{notice}</p>{/if}

<div class="row">
	<button class="btn primary" onclick={() => (showCreate = !showCreate)}>
		{showCreate ? 'Close' : 'New skill'}
	</button>
</div>

{#if showCreate}
	<section>
		<label><span>Name (used for matching, e.g. "Bossa nova")</span><input bind:value={newSkill.name} /></label>
		<label><span>Category directory</span><input bind:value={newSkill.category} /></label>
		<label><span>Body</span><textarea rows="8" bind:value={newSkill.body}></textarea></label>
		<button class="btn primary" onclick={create} disabled={busy || !newSkill.name.trim()}>Create</button>
	</section>
{/if}

{#if editingId && editing}
	<section class="editor">
		<div class="row">
			<h3>{editing.name}</h3>
			<span class="hint">{editing.category}</span>
		</div>
		<textarea
			class="body"
			rows="18"
			bind:value={body}
			oninput={() => (dirty = true)}
			aria-label="Skill markdown"
		></textarea>
		<div class="actions">
			<button class="btn" onclick={close}>Close</button>
			<button class="btn primary" onclick={save} disabled={busy || !dirty}>
				{busy ? 'Saving…' : 'Save'}
			</button>
		</div>
	</section>
{/if}

<ul class="list">
	{#each skills as s (s.id)}
		<li>
			<button class="head" onclick={() => open(s)}>
				<span class="name">{s.name}</span>
				<span class="sum">{s.summary}</span>
				{#if !s.enabled}<span class="off">off</span>{/if}
			</button>
			<div class="ops">
				<label class="check">
					<input type="checkbox" checked={s.enabled} onchange={(e) => toggle(s, e.currentTarget.checked)} />
					<span>Enabled</span>
				</label>
				<button class="btn danger" onclick={() => remove(s)} disabled={busy}>Delete</button>
			</div>
		</li>
	{/each}
</ul>
{#if !skills.length}<p class="hint">No skills indexed yet.</p>{/if}

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
	section {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-bottom: var(--space-3);
	}
	.editor .row {
		justify-content: flex-start;
		align-items: baseline;
		gap: var(--space-2);
	}
	h3 {
		margin: 0;
		font-size: var(--text-sm);
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
	textarea {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
		font-family: inherit;
	}
	textarea.body {
		width: 100%;
		font-family: var(--font-mono, monospace);
		resize: vertical;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		border-radius: var(--radius);
		padding: 2px var(--space-1);
	}
	li:hover {
		background: var(--bg-raise);
	}
	.head {
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		background: none;
		border: none;
		color: var(--fg);
		padding: var(--space-1) 0;
		cursor: pointer;
		font-size: var(--text-sm);
		text-align: left;
		min-width: 0;
	}
	.name {
		flex: none;
		font-weight: 500;
	}
	.sum {
		flex: 1;
		min-width: 0;
		color: var(--fg-dim);
		font-size: var(--text-xs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.off {
		font-size: 0.6rem;
		text-transform: uppercase;
		color: var(--fg-dim);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0 4px;
	}
	.ops {
		display: flex;
		align-items: center;
		gap: var(--space-2);
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
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
