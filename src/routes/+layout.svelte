<script lang="ts">
	import { page } from '$app/state';
	import { themeCss } from '$lib/theme';
	import type { Snippet } from 'svelte';
	import type { LayoutServerData } from './$types';

	let { data, children }: { data: LayoutServerData; children: Snippet } = $props();

	const links = $derived([
		{ href: '/', label: 'Scores' },
		{ href: '/library', label: 'Library' },
		{ href: '/settings', label: 'Settings' },
		...(data.user?.isAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);

	const active = $derived((href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href)
	);

	// The score editor manages its own full-height layout and scrolling.
	const isEditor = $derived(page.url.pathname.startsWith('/score/'));
</script>

<svelte:head>
	<!-- Rendered server-side so the tokens are present before first paint.
	     A light theme would otherwise flash dark on every page load. -->
	{@html `<style id="melody-theme">${themeCss(data.theme)}</style>`}
	<meta name="theme-color" content={data.theme.bg} />
</svelte:head>

<div class="shell">
	<nav class="rail">
		<a class="brand" href="/">
			<span class="mark" aria-hidden="true">♪</span>
			<span class="wordmark">melody</span>
		</a>

		<ul class="nav">
			{#each links as link (link.href)}
				<li>
					<a href={link.href} class="nav-item" class:active={active(link.href)}>{link.label}</a>
				</li>
			{/each}
		</ul>

		<div class="foot">
			{#if data.env !== 'prod'}
				<span class="badge">{data.env}</span>
			{/if}
			<span class="who">{data.user?.displayName || data.user?.username || 'anonymous'}</span>
		</div>
	</nav>

	<main class="main" class:flush={isEditor}>
		{@render children()}
	</main>
</div>

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: var(--font);
		font-size: var(--text-md);
		-webkit-font-smoothing: antialiased;
	}
	:global(button, input, select, textarea) {
		font-family: inherit;
		font-size: inherit;
		border-radius: var(--radius);
	}
	:global(h1, h2, h3, h4) {
		font-weight: 600;
		margin: 0;
	}
	:global(a) {
		color: var(--accent);
	}

	.shell {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}

	.rail {
		flex: 0 0 200px;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		background: var(--bg-pane);
		border-right: 1px solid var(--border);
		padding-top: max(var(--space-4), env(safe-area-inset-top));
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--fg);
		text-decoration: none;
		font-size: var(--text-lg);
		font-weight: 600;
	}
	.mark {
		color: var(--accent);
		font-size: 1.3em;
		line-height: 1;
	}
	.wordmark {
		letter-spacing: 0.02em;
	}

	.nav {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		flex: 1;
	}
	.nav-item {
		display: block;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		color: var(--fg-dim);
		text-decoration: none;
		font-size: var(--text-sm);
	}
	.nav-item:hover {
		background: var(--border);
		color: var(--fg);
	}
	.nav-item.active {
		background: var(--border);
		color: var(--accent);
	}

	.foot {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.badge {
		align-self: flex-start;
		padding: 0 var(--space-2);
		border: 1px solid var(--accent);
		border-radius: 999px;
		color: var(--accent);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.who {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.main {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: var(--space-6);
	}
	/* The editor owns its own scrolling and needs the full viewport. */
	.main.flush {
		padding: 0;
		overflow: hidden;
	}

	@media (max-width: 720px) {
		.shell {
			flex-direction: column;
		}
		.rail {
			flex: 0 0 auto;
			flex-direction: row;
			align-items: center;
			gap: var(--space-3);
			border-right: none;
			border-bottom: 1px solid var(--border);
			overflow-x: auto;
			padding: var(--space-2) var(--space-3);
		}
		.nav {
			flex-direction: row;
			gap: var(--space-1);
		}
		.wordmark,
		.foot {
			display: none;
		}
		.main {
			padding: var(--space-4);
		}
	}
</style>
