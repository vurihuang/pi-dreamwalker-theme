/** Smooth streaming presets: reserve for the next chunk, and the shortest commit interval. */
const SMOOTH_PRESETS = {
	realtime: { targetBufferMs: 40, minCommitMs: 32 },
	balanced: { targetBufferMs: 120, minCommitMs: 48 },
	silky: { targetBufferMs: 170, minCommitMs: 56 },
};

/**
 * Display constants. Edit and `/reload` to change the look.
 * Colors are never defined here: every color is a token of the active pi theme (`themes/dreamwalker.json`).
 */
export const DREAMWALKER = {
	/** Feature switches. */
	features: {
		messageChrome: true,
		runStats: true,
		editor: true,
		footer: true,
		/** Tool rows as `Verb target` plus a `↳ summary` line, without pi's colored shell. */
		toolRows: true,
		/** Draw pi's edit card without its status background: the diff hangs under the `Edit` row. */
		unboxEdit: true,
		/** Fold 3+ consecutive tool calls (not bash/edit/write) into one group card (ctrl+o / click to expand). */
		toolGroup: true,
		/** Reveal streaming text at a steady pace instead of in provider bursts (`smoothStreaming.preset`). */
		smoothStreaming: true,
		/**
		 * While a message streams: re-render only its open tail block (finished blocks are frozen and
		 * cached), and close unfinished `**` / `` ` `` / `[link` so markup never flashes as source.
		 */
		streamRender: true,
		/** Fade newly revealed characters in over `streamFade.fadeMs`. Needs smoothStreaming + streamRender. */
		streamFade: true,
		/** Syntax-highlight bash commands, with heredoc bodies in their own language. */
		shellHighlight: true,
		/**
		 * Highlight code with @pierre/highlights (Wasm, incremental) instead of pi's highlight.js in the
		 * paths this package draws: bash commands (live while args stream), assistant Markdown code
		 * blocks, and expanded read results. Falls back to pi's highlighter when unavailable.
		 */
		fastHighlight: true,
		/**
		 * Color highlighted code with a bundled @pierre/highlights theme (`pierreSyntax`) instead of the
		 * pi theme's nine `syntax*` tokens, so each scope keeps its own color. Needs `fastHighlight`.
		 * Off by default: the dreamwalker theme keeps code calm with its own tokens.
		 */
		pierreSyntax: false,
		/** While the agent works, sweep a soft band of light along the editor's top border. Needs `editor`. */
		borderShimmer: true,
		/**
		 * Run signal (see signal.ts): the editor frame turns error-colored when the run looks stuck and
		 * goes dim after an abort; a failed tool's `↳` blinks in discrete steps. Event-driven: no timer
		 * runs between failures.
		 */
		runSignal: true,
		/** The `↳` line under a tool row: `+12 -4`, `✓ 41 ✕ 3`, `212 lines`, then the duration. */
		resultLine: true,
		/** Run state in the status row above the editor once a run ends: `✓ done 1m05s`, `❚❚ paused`, `✕ failed`. Needs `editor`. */
		statusChip: true,
	},
	/** Run signal (`features.runSignal`). */
	signal: {
		/** Failed tool calls in a row that put the run at risk. */
		failStreak: 3,
		/** Recent calls inspected for a loop, and how often one call must repeat in them (with 2+ failures). */
		window: 6,
		repeats: 3,
		/** Successful calls in a row that clear the risk. */
		recover: 2,
		/** A flash is `flashSteps` steps (lit, off, lit, off) of `flashStepMs` each. */
		flashStepMs: 90,
		flashSteps: 4,
		/** At risk the border shimmer sweeps this much faster (share of `shimmer.periodMs`). */
		riskPeriod: 0.55,
	},
	/** Editor border shimmer (`features.borderShimmer`). */
	shimmer: {
		/**
		 * Shortest frame interval while busy (the ticker stops when the agent is idle). Frames that
		 * other sources (streaming, spinner, input) already painted are not requested again.
		 */
		tickMs: 40,
		/** Longest frame interval: the slowest the band moves on a screen that is expensive to repaint. */
		maxTickMs: 66,
		/**
		 * Share of one core the shimmer's own frames may spend: the interval grows to
		 * `frame cost / frameBudget` (within `tickMs`..`maxTickMs`) as the session gets longer.
		 */
		frameBudget: 0.04,
		/** Time for the band to cross the border once. */
		periodMs: 1800,
		/** Columns on each side of the band's center: `bandRatio` of the border width, at least `halfWidth`. */
		halfWidth: 12,
		bandRatio: 0.18,
		/** Ramp steps from the dimmed frame to the peak. */
		steps: 16,
		/**
		 * OKHSL lightness between the top border and the band's peak (lighter on dark themes, darker on
		 * light ones). Hue never changes. Taken from the color's headroom first; only when a color is
		 * too close to white (black on light themes) is the top border's track moved the other way.
		 */
		swing: 0.28,
		/**
		 * Least OKHSL lightness between the band's peak and the background: dim borders (a dark hairline) get a
		 * bigger swing so the band still reads. Only adds headroom; never moves the track.
		 */
		peakGap: 0.6,
		/**
		 * OKHSL lightness the top border's track drops while busy, so the band stands out against it
		 * (bright borders such as red or orange have little room to get lighter). Bounded by `minGap`.
		 */
		trackDim: 0.3,
		/** The track never moves closer than this (OKHSL lightness) to the background. */
		minGap: 0.14,
		/** Share of the border's saturation the peak keeps (1 = full color, 0 = gray-white). */
		peakSaturation: 0.85,
		/** Band core drawn with the heavy line `━` at or above this fraction of the peak (1.1 = never). */
		heavyFrom: 0.6,
	},
	/** Pierre themes (names of @pierre/highlights/themes/*) used when `features.pierreSyntax` is on. */
	pierreSyntax: {
		dark: "pierre-dark-soft",
		light: "pierre-light-soft",
	},
	/**
	 * Smooth streaming pacer (after streamdown's smoother). `preset` picks the reserve kept for the
	 * next chunk and how often the reveal commits:
	 *
	 *   realtime  40 ms reserve, commits every 32 ms     lowest latency
	 *   balanced  120 ms reserve, commits every 48 ms    default
	 *   silky     170 ms reserve, commits every 56 ms    steadiest flow
	 *
	 * The commit interval widens by `commitPerChars` of open tail, up to `maxCommitMs`, so long
	 * paragraphs and lists keep the work bounded while short blocks stay snappy. Backlog is never
	 * older than ~`maxLagMs`; at message end the rest drains within `settleDrainMinMs`–`settleDrainMaxMs`
	 * instead of jumping. Input that ends inside an open `html` fence is shown at once (live previews).
	 */
	smoothStreaming: {
		preset: "balanced" as "realtime" | "balanced" | "silky",
		get targetBufferMs(): number {
			return SMOOTH_PRESETS[this.preset].targetBufferMs;
		},
		get minCommitMs(): number {
			return SMOOTH_PRESETS[this.preset].minCommitMs;
		},
		/** The ticker's step; commits and frames are rate-limited on top of it. */
		tickMs: 16,
		/** Open-tail characters per extra millisecond of commit interval (0 = never widen). */
		commitPerChars: 40,
		maxCommitMs: 96,
		/** Frame requests for the fade alone (no new text) are at least this far apart. */
		fadeFrameMs: 33,
		maxLagMs: 450,
		flushCps: 120,
		settleDrainMinMs: 120,
		settleDrainMaxMs: 400,
		largeAppendChars: 4000,
	},
	/**
	 * Fade-in of new characters (after streamdown's animation). A character rises from the panel
	 * background (opacity 0) to its own color in `steps` steps over `fadeMs` on streamdown's
	 * `cubic-bezier(0.33, 0, 0.67, 1)` (180 ms in streamdown), then settles;
	 * text of unknown color, or a theme without usable colors, is drawn faint (SGR 2) instead. `word`
	 * fades whole words together. Fenced code skips the fade and reveals as a block.
	 */
	streamFade: {
		fadeMs: 180,
		granularity: "char" as "char" | "word",
		steps: 8,
		/** remend options layered over the defaults (see stream-markdown.ts `REMEND_OPTIONS`), e.g. `{ htmlTags: true }`. */
		remend: undefined as Record<string, unknown> | undefined,
	},
	/** Columns the message body is indented under its header glyph. */
	bodyIndent: 2,
	glyph: {
		/** Bar before a user message, and before the first line of an assistant message. */
		user: "▎",
		assistant: "▲",
		/** Editor prompt. */
		prompt: "›",
		/** Run stats line under a final answer, its cache mark and its copy button. */
		stats: "●",
		cache: "⛁",
		copy: "⧉ copy",
		/** Opens a tool's summary line, and each row of a group card. */
		result: "↳",
		separator: " · ",
		/** Status chip: the live dot and the pause mark. */
		live: "●",
		pause: "❚❚",
		/** Passed / failed counts in a tool's summary. */
		pass: "✓",
		fail: "✕",
	},
	/** Editor card: a rounded line frame. */
	frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", top: "─", bottom: "─", left: "│", right: "│", rule: "─" },
	/** Glyphs the shimmer's band core swaps for a bolder one. */
	shimmerHeavy: { "─": "━" } as Record<string, string>,
	/** Lines shown by the fallback result renderer while collapsed. */
	fallbackPreviewLines: 6,
};
