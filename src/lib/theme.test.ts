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
});
