<script lang="ts">
	/**
	 * A staged change, waiting for a yes or a no.
	 *
	 * A model-driven edit is a proposal until someone has looked at it, so the
	 * control and Ask-box paths commit `accepted: false` and leave a pending
	 * revision behind. Adopting the returned document without offering this
	 * decision is a specific bug rather than a rough edge: the change looks
	 * applied while the history says it was never accepted, and the next stage
	 * inherits an unresolved revision.
	 *
	 * The chunked stage runs — melody, arrangement — deliberately commit accepted
	 * instead, because staging a six-call run would ask twice for one decision.
	 * So this is for the single-turn paths, which is exactly where reviewing a
	 * diff is a real choice rather than a second click on the same intent.
	 */

	interface Props {
		/** What the change was, for the line above the buttons. */
		label: string;
		busy: boolean;
		/** Keep it. Resolves the revision as accepted. */
		onaccept: () => void;
		/** Roll it back. The revision stays in history, marked rejected. */
		onreject: () => void;
	}
	let { label, busy, onaccept, onreject }: Props = $props();
</script>

<section class="pending">
	<p class="label">{label} — not accepted yet</p>
	<div class="row">
		<button class="btn primary" onclick={onaccept} disabled={busy}>Keep it</button>
		<button class="btn" onclick={onreject} disabled={busy}>Undo it</button>
	</div>
</section>

<style>
	.pending {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		padding: var(--space-3);
	}
	.label {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin: 0;
	}
	.row {
		display: flex;
		gap: var(--space-2);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
