import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, PRESETS, normalizeTheme, themeCss } from './theme.js';

describe('themes', () => {
	it('every preset is complete and survives normalisation unchanged', () => {
		for (const [name, preset] of Object.entries(PRESETS)) {
			for (const key of Object.keys(DEFAULT_THEME)) {
				expect(preset, `${name} is missing ${key}`).toHaveProperty(key);
			}
			// A preset that normalisation would alter is a preset with a value
			// the sanitiser rejects — i.e. a latent broken theme.
			expect(normalizeTheme(preset), name).toEqual(preset);
		}
	});

	it('every preset colour is a valid hex value', () => {
		const colourKeys = [
			'bg', 'bgPane', 'bgRaise', 'fg', 'fgDim', 'accent', 'border', 'danger',
			'diffAdd', 'diffRemove', 'diffChange', 'notation', 'notationPaper'
		] as const;
		for (const [name, preset] of Object.entries(PRESETS)) {
			for (const key of colourKeys) {
				expect(preset[key], `${name}.${key}`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
			}
		}
	});

	it('rejects CSS and HTML breakout attempts, falling back to defaults', () => {
		const t = normalizeTheme({
			accent: 'red}</style><script>alert(1)</script>',
			font: 'x; background: url(evil)',
			bg: '#000{',
			radius: '5px\\',
			notation: 'a'.repeat(500)
		});
		expect(t.accent).toBe(DEFAULT_THEME.accent);
		expect(t.font).toBe(DEFAULT_THEME.font);
		expect(t.bg).toBe(DEFAULT_THEME.bg);
		expect(t.radius).toBe(DEFAULT_THEME.radius);
		expect(t.notation).toBe(DEFAULT_THEME.notation);

		const css = themeCss(t);
		expect(css).not.toContain('script');
		expect(css).not.toContain('</style>');
	});

	it('fills in fields a theme saved before they existed does not have', () => {
		const old = { bg: '#111111', fg: '#eeeeee' };
		const t = normalizeTheme(old);
		expect(t.bg).toBe('#111111');
		expect(t.fg).toBe('#eeeeee');
		expect(t.notationPaper).toBe(DEFAULT_THEME.notationPaper);
		expect(t.spaceBase).toBe(DEFAULT_THEME.spaceBase);
	});

	it('clamps out-of-range numeric fields rather than emitting broken CSS', () => {
		const t = normalizeTheme({ notationScale: -5, spaceBase: 9999 });
		expect(t.notationScale).toBe(DEFAULT_THEME.notationScale);
		expect(t.spaceBase).toBe(DEFAULT_THEME.spaceBase);
		expect(normalizeTheme({ notationScale: 1.5 }).notationScale).toBe(1.5);
	});

	it('handles null, undefined and non-objects', () => {
		expect(normalizeTheme(null)).toEqual(DEFAULT_THEME);
		expect(normalizeTheme(undefined)).toEqual(DEFAULT_THEME);
		expect(normalizeTheme('nope')).toEqual(DEFAULT_THEME);
	});

	it('emits every token the stylesheet relies on', () => {
		const css = themeCss(DEFAULT_THEME);
		for (const token of [
			'--bg:', '--bg-pane:', '--bg-raise:', '--fg:', '--fg-dim:', '--accent:',
			'--border:', '--danger:', '--diff-add:', '--diff-remove:', '--diff-change:',
			'--notation:', '--notation-paper:', '--notation-scale:', '--font:', '--radius:',
			'--space-1:', '--space-8:', '--text-xs:', '--text-xl:'
		]) {
			expect(css, token).toContain(token);
		}
		expect(css).toContain('html{font-size:');
	});

	it('derives the spacing scale from spaceBase', () => {
		const css = themeCss({ ...DEFAULT_THEME, spaceBase: 0.5 });
		expect(css).toContain('--space-1:0.500rem;');
		expect(css).toContain('--space-2:1.000rem;');
	});

	describe('light score paper', () => {
		// Contrast is the preset that put a black sheet under white ink, which is
		// what made the score look broken rather than styled.
		const dark = { ...PRESETS.Contrast, lightScorePaper: true };

		it('overrides both score tokens when on', () => {
			const css = themeCss(dark);
			expect(css).toContain('--notation:#1a1a1a;');
			expect(css).toContain('--notation-paper:#ffffff;');
		});

		it('leaves the rest of the preset alone', () => {
			const css = themeCss(dark);
			expect(css).toContain(`--bg:${PRESETS.Contrast.bg};`);
			expect(css).toContain(`--accent:${PRESETS.Contrast.accent};`);
		});

		it('does not overwrite the stored colours, so turning it off restores them', () => {
			expect(dark.notation).toBe(PRESETS.Contrast.notation);
			const css = themeCss({ ...dark, lightScorePaper: false });
			expect(css).toContain(`--notation:${PRESETS.Contrast.notation};`);
			expect(css).toContain(`--notation-paper:${PRESETS.Contrast.notationPaper};`);
		});

		it('round-trips through the normaliser', () => {
			expect(normalizeTheme({ lightScorePaper: true }).lightScorePaper).toBe(true);
			expect(normalizeTheme({ lightScorePaper: false }).lightScorePaper).toBe(false);
			// A non-boolean falls back to the default rather than being coerced.
			expect(normalizeTheme({ lightScorePaper: 'yes' }).lightScorePaper).toBe(
				DEFAULT_THEME.lightScorePaper
			);
		});
	});

	describe('atmosphere', () => {
		it('is off in every preset but Understory', () => {
			// A drifting haze over a bright white interface reads as a rendering
			// fault, so it belongs to a palette chosen for it rather than to
			// everyone by default.
			for (const [name, preset] of Object.entries(PRESETS)) {
				expect(preset.atmosphere).toBe(name === 'Understory');
			}
		});

		it('survives normalisation in both states', () => {
			expect(normalizeTheme({ ...PRESETS.Understory }).atmosphere).toBe(true);
			expect(normalizeTheme({ ...PRESETS.Studio }).atmosphere).toBe(false);
		});

		it('falls back to the default for a theme saved before the field existed', () => {
			// Every stored theme predates this field, so this is the upgrade path
			// rather than an edge case.
			const old = { bg: '#111111', fg: '#eeeeee' };
			expect(normalizeTheme(old).atmosphere).toBe(DEFAULT_THEME.atmosphere);
		});

		it('ignores a non-boolean rather than emitting one', () => {
			expect(normalizeTheme({ atmosphere: 'yes' }).atmosphere).toBe(DEFAULT_THEME.atmosphere);
		});
	});

	describe('the Understory preset', () => {
		it('keeps the score on a light sheet', () => {
			// The point of a dark wooded interface is that the score reads as a
			// lit page inside it.
			const t = PRESETS.Understory;
			expect(t.lightScorePaper).toBe(true);
			expect(themeCss(t)).toContain('--notation:#1a1a1a');
		});

		it('is the default', () => {
			expect(DEFAULT_THEME).toBe(PRESETS.Understory);
		});

		it('does not reuse a green for added notes', () => {
			// diffAdd is green in every other preset and would disappear into
			// green chrome. These three mark every AI review, so they have to
			// stay distinguishable from the background and from each other.
			const { diffAdd, diffRemove, diffChange, accent, bg } = PRESETS.Understory;
			expect(new Set([diffAdd, diffRemove, diffChange]).size).toBe(3);
			for (const c of [diffAdd, diffRemove, diffChange]) {
				expect(c).not.toBe(accent);
				expect(c).not.toBe(bg);
			}
			// Specifically not the green the other dark presets use, which is
			// the one that would vanish here.
			expect(diffAdd.toLowerCase()).not.toBe('#4ade80');

			// And green-dominant at all: in a green interface, "added" has to be
			// carried by hue difference rather than by being another green.
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(diffAdd.slice(i, i + 2), 16));
			expect(g > r && g > b).toBe(false);
		});

		it('is dark, so it is not listed as a light preset', async () => {
			const { LIGHT_PRESETS } = await import('./theme.js');
			expect(LIGHT_PRESETS.has('Understory')).toBe(false);
		});
	});
});
