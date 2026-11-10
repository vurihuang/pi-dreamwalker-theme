/**
 * pi-dreamwalker-theme: quiet gray chrome for pi.
 *
 * - user bar, assistant mark, indented bodies, run stats  (messages.ts)
 * - status row above a neutral rounded input card         (editor.ts)
 * - one-line footer: place on the left, context and spend (footer.ts)
 * - `Verb target` tool rows with a `↳ summary` line       (tools.ts)
 *
 * Colors always come from the active pi theme (the bundled `dreamwalker` theme is tuned for it). Terminal UI is only touched in `tui`
 * mode; the chronicle (run stats) is fed from extension events that pi delivers before it
 * renders and persists, so nothing polls and nothing rescans the session while streaming.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Color, rgbColor, type TerminalColors, type TUI } from "@earendil-works/pi-tui";
import { type AssistantLike, Chronicle, type UserLike } from "./chronicle.ts";
import { DREAMWALKER } from "./config.ts";
import { DreamEditor, type EditorLabels } from "./editor.ts";
import { DreamFooter, type FooterSource } from "./footer.ts";
import { installToolGrouping, type GroupingHooks } from "./grouping.ts";
import { installMessageChrome, uninstallMessageChrome } from "./messages.ts";
import { setFlashRender, signal } from "./signal.ts";
import { createToolRenderers } from "./tools.ts";

/** `stopReason` of the last assistant message of a run (`aborted`, `error`, `stop`, …). */
function lastStopReason(messages: ReadonlyArray<unknown>): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string };
		if (message?.role === "assistant") return message.stopReason;
	}
	return undefined;
}

export default function dreamwalker(pi: ExtensionAPI) {
	const features = DREAMWALKER.features;
	const chronicle = new Chronicle();
	let ctx: ExtensionContext | undefined;
	let theme: Theme | undefined;
	let grouping: GroupingHooks | undefined;
	let labels: EditorLabels = {};
	let runStart: number | undefined;
	const editorLabels = (): EditorLabels => ({ ...labels, runStart });
	/** Captured from the editor/footer factories; the drip needs it to request frames. */
	let tui: TUI | undefined;
	/** The terminal's default background (OSC 11): the fade-in starts from it. */
	let terminalBackground: Color | undefined;
	let queried: TUI | undefined;
	const captureTui = (next: TUI) => {
		tui = next;
		if (queried === next || !features.streamFade) return;
		queried = next;
		const take = (colors: TerminalColors) => {
			const bg = colors.background;
			if (bg) terminalBackground = rgbColor(bg.r, bg.g, bg.b);
		};
		void next.queryTerminalColors({ timeoutMs: 1000, onLateReply: take }).then(take, () => {});
	};

	const getTheme = (): Theme => {
		if (!theme) throw new Error("pi-dreamwalker-theme: theme requested before session_start");
		return theme;
	};

	const refreshLabels = (model: ExtensionContext["model"], level: string) => {
		labels = {
			provider: model?.provider,
			model: model?.id,
			thinking: model?.reasoning ? (level === "off" ? "thinking off" : level) : undefined,
		};
	};

	if (features.toolRows) {
		// Not gated on session_start: /reload re-resolves existing rows before the new session starts.
		pi.registerToolRenderer((toolName, next) => createToolRenderers(toolName, next()));
	}

	if (features.toolGroup) {
		// Install once, outside session_start: the patch owns the Container prototype across reloads,
		// and /reload replaces it in place rather than stacking a second interception.
		grouping = installToolGrouping({ enabled: true });
		grouping.setRequestRender(() => tui?.requestRender());
	}

	pi.on("session_start", (_event, startCtx) => {
		if (startCtx.mode !== "tui") return;
		ctx = startCtx;
		theme = startCtx.ui.theme;
		grouping?.setTheme(theme);
		chronicle.reindex(startCtx.sessionManager.getBranch());
		refreshLabels(startCtx.model, pi.getThinkingLevel());

		if (features.messageChrome) {
			installMessageChrome({
				theme: getTheme,
				chronicle,
				notify: (message) => ctx?.ui.notify(message, "info"),
				showRunStats: features.runStats,
				smooth: features.smoothStreaming ? DREAMWALKER.smoothStreaming : undefined,
				streamRender: features.streamRender,
				fade: features.streamFade ? DREAMWALKER.streamFade : undefined,
				terminalBackground: () => terminalBackground,
				requestRender: () => {
					if (!tui) return false;
					tui.requestRender();
					return true;
				},
			});
		}

		if (features.editor) {
			startCtx.ui.setEditorComponent(
				(editorTui, editorTheme, editorKeys) => {
					captureTui(editorTui);
					return new DreamEditor(editorTui, editorTheme, editorKeys, getTheme, editorLabels, 0);
				},
			);
		}

		if (features.footer) {
			const sessionManager = startCtx.sessionManager;
			const source: FooterSource = {
				// Every append moves the leaf; the model decides the pricing.
				sessionKey: () => `${sessionManager.getSessionId()}|${sessionManager.getLeafId()}|${labels.provider}/${labels.model}`,
				entries: () => sessionManager.getEntries(),
				sessionName: () => sessionManager.getSessionName(),
				cwd: () => sessionManager.getCwd(),
				context: () => ctx?.getContextUsage(),
			};
			startCtx.ui.setFooter(
				(footerTui, _theme, data) => {
					captureTui(footerTui);
					return new DreamFooter(getTheme, data, () => (ctx ? source : undefined), () =>
						footerTui.requestRender(),
					);
				},
			);
		}
	});

	pi.on("session_shutdown", (event) => {
		// On reload/new/resume/fork pi rebuilds messages before the next session_start; keep the
		// patch (and its last deps) so they keep their chrome. The next runtime re-installs its own.
		if (event.reason === "quit") {
			signal.reset();
			setFlashRender(undefined);
			uninstallMessageChrome();
			grouping?.shutdown();
			grouping = undefined;
		}
		ctx = undefined;
	});

	pi.on("session_tree", (_event, treeCtx) => {
		if (treeCtx.mode !== "tui") return;
		chronicle.reindex(treeCtx.sessionManager.getBranch());
		// /reload, resume and compaction rebuild the transcript without re-running addChild.
		grouping?.refresh(tui);
	});

	pi.on("session_compact", (_event, compactCtx) => {
		if (compactCtx.mode !== "tui") return;
		grouping?.setTheme(compactCtx.ui.theme);
		grouping?.refresh(tui);
	});

	pi.on("agent_start", () => {
		runStart = Date.now();
		chronicle.onAgentStart(runStart);
		if (features.runSignal) signal.agentStart(runStart);
	});
	pi.on("agent_end", (event) => {
		runStart = undefined;
		chronicle.onAgentEnd();
		if (features.runSignal) signal.agentEnd(lastStopReason(event.messages));
	});

	if (features.runSignal) {
		// Frames for the failure flash come from the TUI the editor or footer captured.
		setFlashRender(() => tui?.requestRender());
		pi.on("tool_execution_start", (event) => signal.toolStart(event.toolCallId, event.parentToolCallId));
		pi.on("tool_result", (event) => {
			signal.toolResult(event.toolName, event.input, event.isError, event.parentToolCallId);
		});
	}

	pi.on("message_start", (event) => {
		const message = event.message as { role: string };
		if (message.role === "user") chronicle.onUserMessage(message as UserLike);
		else if (message.role === "assistant") chronicle.onAssistantStart(message as AssistantLike);
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role: string };
		if (message.role === "assistant") chronicle.onAssistantEnd(message as AssistantLike);
	});

	pi.on("model_select", (event) => refreshLabels(event.model, pi.getThinkingLevel()));
	pi.on("thinking_level_select", (event, selectCtx) => refreshLabels(selectCtx.model, event.level));
}
