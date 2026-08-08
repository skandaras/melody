/**
 * Theming, shared by the server (persistence) and the client (live editor).
 *
 * A TypeScript module rather than a stylesheet, so there is one typed contract
 * the DB stores, the editor binds to, and tests assert on. Every value ends up
 * as a CSS custom property; nothing is hardcoded in a component.
 *
 * Melody carries more chrome than a chat app — a score canvas, a transport, a
 * control rack, an inspector — so unlike galaxy this includes explicit spacing
 * and type scales. Hand-picked rem values across forty components drift.
 */

export interface Theme {
	/** Page background. */
	bg: string;
	/** Panel and card background. */
	bgPane: string;
	/** Raised surfaces: the score paper, popovers. */
	bgRaise: string;
	/** Foreground text. */
	fg: string;
	/** Dimmed text. */
	fgDim: string;
	/** Links, active states, primary buttons. */
	accent: string;
	/** Borders, separators, and secondary button fill. */
	border: string;
	/** Errors and destructive actions. */
	danger: string;
	/** Notes the AI added, in the accept/reject diff. */
	diffAdd: string;
	/** Notes the AI removed. */
	diffRemove: string;
	/** Notes the AI modified in place. */
	diffChange: string;
	/** Ink colour for the notation itself — staves, noteheads, stems. */
	notation: string;
	/** Paper behind the notation. Kept separate from bgRaise so a dark UI can
	 *  still show a light score, which is what most people want to read. */
	notationPaper: string;
	/** UI font stack. */
	font: string;
	/** Corner radius for controls, e.g. "6px" or "999px". */
	radius: string;
	/**
	 * Root font size. A percentage resolves against the browser's own default,
	 * so anyone who has already set a larger base size keeps that relationship;
	 * a length pins it absolutely. Both are accepted.
	 */
	baseFont: string;
	/** Multiplier on notation size, independent of UI scale — people want big
	 *  notes and small chrome, or the reverse. */
	notationScale: number;
	/** Spacing scale base in rem. Every --space-N is a multiple of this. */
	spaceBase: number;
}

export const PRESETS: Record<string, Theme> = {
	Studio: {
		bg: '#0e1014', bgPane: '#161920', bgRaise: '#1e222b',
		fg: '#dde3ee', fgDim: '#7d8699', accent: '#6ea8fe',
		border: '#262b36', danger: '#ff6b7a',
		diffAdd: '#4ade80', diffRemove: '#f87171', diffChange: '#fbbf24',
		notation: '#1a1a1a', notationPaper: '#faf8f4',
		font: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
		radius: '6px', baseFont: '100%', notationScale: 1, spaceBase: 0.25
	},
	Manuscript: {
		bg: '#f4f1e8', bgPane: '#fbf9f3', bgRaise: '#ffffff',
		fg: '#2b2a26', fgDim: '#7b776c', accent: '#9a5b34',
		border: '#ddd7c7', danger: '#b3453f',
		diffAdd: '#2f7d44', diffRemove: '#b3453f', diffChange: '#b07d1a',
		notation: '#1c1a16', notationPaper: '#ffffff',
		font: "'Iowan Old Style', 'Palatino Linotype', Georgia, serif",
		radius: '3px', baseFont: '104%', notationScale: 1.05, spaceBase: 0.25
	},
	Midnight: {
		bg: '#07070c', bgPane: '#0e0e17', bgRaise: '#15151f',
		fg: '#d6d3e8', fgDim: '#6a6683', accent: '#a78bfa',
		border: '#1e1c2c', danger: '#fb7185',
		diffAdd: '#34d399', diffRemove: '#fb7185', diffChange: '#facc15',
		notation: '#e8e6f0', notationPaper: '#12121b',
		font: "'Inter', ui-sans-serif, system-ui, sans-serif",
		radius: '8px', baseFont: '100%', notationScale: 1, spaceBase: 0.25
	},
	Contrast: {
		bg: '#000000', bgPane: '#0b0b0b', bgRaise: '#141414',
		fg: '#ffffff', fgDim: '#a0a0a0', accent: '#ffd400',
		border: '#333333', danger: '#ff4d4d',
		diffAdd: '#00e676', diffRemove: '#ff5252', diffChange: '#ffd400',
		notation: '#ffffff', notationPaper: '#000000',
		font: "ui-sans-serif, system-ui, sans-serif",
		radius: '2px', baseFont: '112%', notationScale: 1.2, spaceBase: 0.28
	},
	Paper: {
		bg: '#eceff4', bgPane: '#ffffff', bgRaise: '#ffffff',
		fg: '#2e3440', fgDim: '#7b8494', accent: '#4c6ef5',
		border: '#d8dee9', danger: '#c0392b',
		diffAdd: '#2f9e44', diffRemove: '#c0392b', diffChange: '#e8a13a',
		notation: '#1a1a1a', notationPaper: '#ffffff',
		font: "'Inter', ui-sans-serif, system-ui, sans-serif",
		radius: '6px', baseFont: '100%', notationScale: 1, spaceBase: 0.25
	}
};

export const DEFAULT_THEME: Theme = PRESETS.Studio;

/** Which presets should render with a light UA canvas before CSS loads. */
export const LIGHT_PRESETS = new Set(['Manuscript', 'Paper']);

export function themeCss(t: Theme): string {
	const space = (n: number) => `${(t.spaceBase * n).toFixed(3)}rem`;
	return [
		':root{',
		`--bg:${t.bg};`,
		`--bg-pane:${t.bgPane};`,
		`--bg-raise:${t.bgRaise};`,
		`--fg:${t.fg};`,
		`--fg-dim:${t.fgDim};`,
		`--accent:${t.accent};`,
		`--border:${t.border};`,
		`--danger:${t.danger};`,
		`--diff-add:${t.diffAdd};`,
		`--diff-remove:${t.diffRemove};`,
		`--diff-change:${t.diffChange};`,
		`--notation:${t.notation};`,
		`--notation-paper:${t.notationPaper};`,
		`--notation-scale:${t.notationScale};`,
		`--font:${t.font};`,
		`--radius:${t.radius};`,
		// A spacing scale rather than hand-picked rem values, so density is one
		// knob instead of a find-and-replace across every component.
		`--space-1:${space(1)};`,
		`--space-2:${space(2)};`,
		`--space-3:${space(3)};`,
		`--space-4:${space(4)};`,
		`--space-6:${space(6)};`,
		`--space-8:${space(8)};`,
		'--text-xs:0.72rem;',
		'--text-sm:0.82rem;',
		'--text-md:0.92rem;',
		'--text-lg:1.1rem;',
		'--text-xl:1.4rem;',
		'}',
		`html{font-size:${t.baseFont};}`
	].join('');
}

/**
 * Keep persisted themes shaped like a Theme across future field changes, and
 * keep them safe.
 *
 * String values are emitted into a <style> tag, so anything that could break
 * out of a CSS declaration is rejected outright rather than escaped — a
 * whitelist of harmless characters is far easier to reason about than an
 * escaping routine, and this is stored self-XSS if it's wrong.
 */
export function normalizeTheme(raw: unknown): Theme {
	const r = (raw ?? {}) as Record<string, unknown>;
	const out: Theme = { ...DEFAULT_THEME };

	for (const key of Object.keys(DEFAULT_THEME) as (keyof Theme)[]) {
		const v = r[key];
		const def = DEFAULT_THEME[key];

		if (typeof def === 'number') {
			if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10) {
				(out[key] as number) = v;
			}
		} else if (typeof def === 'string') {
			if (typeof v === 'string' && v.length > 0 && v.length < 200 && !/[<>{};\\]/.test(v)) {
				(out[key] as string) = v;
			}
		}
	}
	return out;
}

/** Named custom themes a user has saved, capped so one account can't grow
 *  the settings row without bound. */
export const MAX_CUSTOM_THEMES = 24;
