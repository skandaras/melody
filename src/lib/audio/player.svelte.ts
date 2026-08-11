import { gainFor, type MixOverrides } from './mix';
import { Player, type TransportState } from './synth';
import type { Score } from '$lib/score/types';

/**
 * The reactive handle that the transport bar and the mixer share.
 *
 * `Player` itself stays framework-free — plain TypeScript, exercisable without
 * a component harness — and this class is the only place runes touch it. There
 * is exactly one per editor page: the AudioContext, the worklet and the 36MB
 * soundfont are all far too expensive to hold per component.
 */

export type { MixOverrides };

const IDLE: TransportState = {
	ready: false,
	loading: false,
	playing: false,
	position: 0,
	duration: 0,
	error: null
};

export class PlayerStore {
	transport = $state<TransportState>({ ...IDLE });

	/**
	 * Solo is deliberately session state, never document state. Muting a part
	 * changes what gets exported; soloing one is just how you happen to be
	 * listening right now, so it must not reach the score or a rendered WAV.
	 */
	solo = $state<Set<string>>(new Set());

	#player: Player;
	#off: () => void;
	/** True once the sequencer's loaded MIDI is stale against the document. */
	#dirty = true;
	#overrides: MixOverrides = {};

	constructor(soundfontUrl: () => string) {
		this.#player = new Player(soundfontUrl);
		this.#off = this.#player.subscribe((s) => (this.transport = s));
	}

	/** Any edit invalidates what the sequencer holds. Reloading eagerly on every
	 *  keystroke would re-serialise constantly, so mark it stale and reload on
	 *  the next play instead. */
	invalidate(): void {
		this.#dirty = true;
	}

	async toggle(score: Score): Promise<void> {
		try {
			if (this.transport.playing) {
				this.#player.pause();
				return;
			}
			await this.#reload(score);
			await this.#player.play();
			// Starting playback can reset channel controllers, so the mix has to
			// be re-asserted after play() rather than only after load().
			this.applyMix(score, this.#overrides);
		} catch {
			// Already surfaced through transport.error by the player.
		}
	}

	stop(): void {
		this.#player.stop();
	}

	seek(seconds: number): void {
		this.#player.seek(seconds);
	}

	async #reload(score: Score): Promise<void> {
		if (!this.#dirty) return;
		// Muted parts are kept in the sequence and silenced with CC7 instead of
		// being dropped, so unmuting is instant rather than a reload. Exports
		// still omit them — that is scoreToMidi's default.
		await this.#player.load(score, { skipMuted: false });
		this.#dirty = false;
		this.applyMix(score, this.#overrides);
	}

	toggleSolo(partId: string, score: Score): void {
		const next = new Set(this.solo);
		if (next.has(partId)) next.delete(partId);
		else next.add(partId);
		this.solo = next;
		this.applyMix(score, this.#overrides);
	}

	clearSolo(score: Score): void {
		this.solo = new Set();
		this.applyMix(score, this.#overrides);
	}

	/**
	 * Push every part's level to the synth as CC7.
	 *
	 * `overrides` carries fader moves the user has made but which have not been
	 * committed to the document yet, so dragging is audible immediately without
	 * a network round trip per pixel.
	 */
	applyMix(score: Score, overrides: MixOverrides = {}): void {
		this.#overrides = overrides;
		for (const part of score.parts) {
			this.#player.setChannelVolume(part.channel, gainFor(part, overrides, this.solo));
		}
	}

	destroy(): void {
		this.#off();
		this.#player.destroy();
	}
}
