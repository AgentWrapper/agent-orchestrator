import { Feather } from "@expo/vector-icons";
import { XtermJsWebView, type XtermWebViewHandle } from "@fressh/react-native-xtermjs-webview";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { getPreview, isTerminalStatus, killSession, sendMessage } from "../../lib/api";
import { isConfigured, loadConfig, type ServerConfig } from "../../lib/config";
import { MuxClient, type MuxStatus } from "../../lib/mux";
import { useApp } from "../../lib/store";
import { theme } from "../../lib/theme";

const FONT_SIZE = 12;

// Injected into the xterm WebView after load. xterm has its own touch handlers
// that scroll by discrete lines (the janky "1 line per swipe"). We intercept in
// the CAPTURE phase and stopPropagation so those handlers never fire, then drive
// the viewport's scrollTop in proportion to finger movement (+ momentum). Taps
// (no significant movement) are left alone so tap-to-focus / keyboard still work.
const TERMINAL_ENHANCE_JS = `
(function () {
  // The text layer (xterm-screen canvas) captures touches for selection, which
  // blocks the smooth native scroll. Make it (and the hidden input) transparent
  // to touch so drags fall through to the viewport's native scroll, and so a tap
  // can't focus the input (no surprise keyboard).
  var s = document.createElement('style');
  s.textContent =
    '.xterm-screen{pointer-events:none !important;}' +
    '.xterm-helper-textarea{pointer-events:none !important;}' +
    '.xterm-viewport{pointer-events:auto !important;-webkit-overflow-scrolling:touch !important;}';
  document.head.appendChild(s);

  // Report xterm's REAL grid size (measured by the FitAddon from the actual
  // rendered cell) back to RN through fressh's own debug channel, so RN can tell
  // the PTY the exact cols/rows xterm is using - no font/DPR guessing.
  function postDims(sz) {
    try {
      var T = window.terminal; if (!T) return;
      var c = (sz && sz.cols) || T.cols, r = (sz && sz.rows) || T.rows;
      if (window.ReactNativeWebView && c > 0 && r > 0) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'debug', message: 'FRESSH_DIMS ' + c + ' ' + r }));
      }
    } catch (_) {}
  }

  // When the keyboard/rotation resizes the terminal, keep it pinned to the bottom
  // (latest output) instead of jumping to the top.
  function pinBottom() { try { window.terminal.scrollToBottom(); } catch (_) {} }
  (function wire() {
    if (window.terminal && window.terminal.onResize && window.fitAddon) {
      window.terminal.onResize(function (sz) { setTimeout(pinBottom, 0); postDims(sz); });
      // Re-fit whenever the WebView's box changes (keyboard show/hide, rotation).
      // fit() updates xterm to the real fit; onResize above then reports the dims.
      try {
        var host = document.getElementById('terminal') || document.body;
        var ro = new ResizeObserver(function () {
          try { window.fitAddon.fit(); } catch (_) {}
        });
        ro.observe(host);
      } catch (_) {}
      postDims(); // report the initial (boot-fit) dims immediately
    } else {
      setTimeout(wire, 200);
    }
  })();

  // Keyboard is handled by a React-Native TextInput, NOT the WebView. We disable
  // the WebView's hidden textarea (see harden) so it can never raise a keyboard
  // or steal first-responder. The keyboard button shows/hides the keyboard.

  // Gesture routing (canvas is pointer-events:none, so we read touches here):
  //  - quick drag -> native scroll (we don't preventDefault)
  //  - long-press -> select the line; drag extends by lines; release copies
  //  - single tap -> nothing   - double-tap -> focus (keyboard)
  function term() { return window.terminal; }
  function lineAt(clientY) {
    var T = term(), screen = document.querySelector('.xterm-screen');
    if (!T || !screen) return 0;
    var r = screen.getBoundingClientRect();
    var ch = r.height / T.rows;
    var vis = Math.floor((clientY - r.top) / ch);
    if (vis < 0) vis = 0; if (vis > T.rows - 1) vis = T.rows - 1;
    var top = (T.buffer && T.buffer.active) ? T.buffer.active.viewportY : 0;
    return top + vis;
  }
  function copySel() {
    var T = term(); if (!T) return; var txt = '';
    try { txt = T.getSelection(); } catch (_) {}
    if (!txt) return;
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt); } catch (_) {}
  }

  var sX = 0, sY = 0, mode = 'idle', anchor = 0, lpTimer = 0;
  var MOVE = 10, LONGPRESS = 350;
  // Android: we drive the viewport's scrollTop directly off finger movement -
  // its native overflow-scroll doesn't respond to touch reliably in the WebView,
  // which is why the terminal felt unscrollable there. iOS keeps native momentum.
  var _vp = null, startScroll = 0;
  function clearLP() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } }

  document.addEventListener('touchstart', function (e) {
    var t = e.touches ? e.touches[0] : e;
    sX = t.clientX; sY = t.clientY; mode = 'pending';
    _vp = document.querySelector('.xterm-viewport');
    startScroll = _vp ? _vp.scrollTop : 0;
    try { term() && term().clearSelection(); } catch (_) {}
    clearLP();
    lpTimer = setTimeout(function () {
      if (mode !== 'pending') return;
      mode = 'select'; anchor = lineAt(sY);
      try { term().selectLines(anchor, anchor); } catch (_) {}
    }, LONGPRESS);
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', function (e) {
    var t = e.touches ? e.touches[0] : e;
    if (mode === 'pending') {
      if (Math.abs(t.clientX - sX) > MOVE || Math.abs(t.clientY - sY) > MOVE) {
        mode = 'scroll'; clearLP();
      }
      return;
    }
    if (mode === 'scroll') {
      // Android: move the viewport ourselves, 1:1 with the finger. iOS: leave it
      // to the viewport's native momentum scroll (don't preventDefault).
      if (IS_ANDROID && _vp) {
        _vp.scrollTop = startScroll - (t.clientY - sY);
        if (e.cancelable) e.preventDefault();
      }
      return;
    }
    if (mode === 'select') {
      if (e.cancelable) e.preventDefault();  // stop native scroll while selecting
      var cur = lineAt(t.clientY);
      try { term().selectLines(Math.min(anchor, cur), Math.max(anchor, cur)); } catch (_) {}
    }
  }, { capture: true, passive: false });

  document.addEventListener('touchend', function () {
    clearLP();
    if (mode === 'select') copySel(); // a tap (no move) does nothing
    mode = 'idle';
  }, { capture: true, passive: true });

  // Disable the WebView's hidden textarea so it can NEVER show a keyboard or
  // steal first-responder from the RN input. RN handles all keyboard I/O.
  function harden() {
    var t = document.querySelector('.xterm-helper-textarea');
    if (t) {
      t.disabled = true;
      t.setAttribute('inputmode', 'none');
      t.setAttribute('readonly', 'readonly');
      t.setAttribute('autocorrect', 'off');
      t.setAttribute('autocapitalize', 'off');
      t.setAttribute('autocomplete', 'off');
      t.setAttribute('spellcheck', 'false');
    }
  }
  harden(); setTimeout(harden, 400); setTimeout(harden, 1500);
  setInterval(harden, 3000); // keep it disabled if xterm recreates it
  true;
})();
true;
`;

// Keys a phone keyboard lacks - sent straight to the PTY as escape sequences.
const EXTRA_KEYS: { label: string; seq: string }[] = [
	{ label: "esc", seq: "\x1b" },
	{ label: "tab", seq: "\t" },
	{ label: "^C", seq: "\x03" },
	{ label: "←", seq: "\x1b[D" },
	{ label: "↑", seq: "\x1b[A" },
	{ label: "↓", seq: "\x1b[B" },
	{ label: "→", seq: "\x1b[C" },
	{ label: "↵", seq: "\r" },
];

// Named keys a hardware/Bluetooth keyboard emits (key.length > 1) mapped to the
// bytes the PTY expects. Single-char keys are sent as-is.
const NAMED_KEYS: Record<string, string> = {
	Backspace: "\x7f",
	Enter: "\r",
	"\n": "\r",
	Space: " ",
	Tab: "\t",
	Escape: "\x1b",
	ArrowUp: "\x1b[A",
	ArrowDown: "\x1b[B",
	ArrowRight: "\x1b[C",
	ArrowLeft: "\x1b[D",
};

const statusLabel: Record<MuxStatus, string> = {
	connecting: "connecting...",
	open: "live",
	closed: "disconnected",
	error: "error",
};
const statusColors: Record<MuxStatus, string> = {
	connecting: theme.attention,
	open: theme.green,
	closed: theme.textTertiary,
	error: theme.red,
};

export default function TerminalScreen() {
	const params = useLocalSearchParams<{ id: string; projectId?: string }>();
	const id = String(params.id);
	const projectId = params.projectId ? String(params.projectId) : undefined;
	const router = useRouter();
	const navigation = useNavigation();
	const insets = useSafeAreaInsets();

	// Leaving the screen: pop when there's history, otherwise go to the board.
	// Guards against a missing/broken back button when this route was cold-started
	// with no back-stack - e.g. a reload while on the terminal, or a deep link.
	const leave = useCallback(() => {
		if (router.canGoBack()) router.back();
		else router.replace("/");
	}, [router]);

	const xtermRef = useRef<XtermWebViewHandle | null>(null);
	const muxRef = useRef<MuxClient | null>(null);
	const openedRef = useRef(false);
	// Last grid size reported by the WebView's FitAddon, so we can send it to the
	// PTY the moment the terminal opens (dims may arrive before or after open).
	const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
	// The REAL keyboard input. The WebView can't show/control a keyboard reliably,
	// so this hidden RN TextInput is what raises the keyboard and captures typing,
	// which we forward to the PTY over the mux. Focus it to type, blur it to hide.
	const kbInputRef = useRef<TextInput | null>(null);

	const [cfg, setCfg] = useState<ServerConfig | null>(null);
	const [status, setStatus] = useState<MuxStatus>("connecting");
	const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
	const [banner, setBanner] = useState<string | null>(null);
	const [kbHeight, setKbHeight] = useState(0); // iOS: space to reserve for keyboard
	const [kbVisible, setKbVisible] = useState(false); // both platforms
	const [compose, setCompose] = useState(false); // high-level "send message" bar
	const [msg, setMsg] = useState("");
	const [sending, setSending] = useState(false);
	// Terminal font size. Smaller font = more rows/cols, which is the only way to
	// see more of a full-screen TUI (alt-screen apps have no scrollback). Changing
	// it remounts the xterm; the PTY persists and re-attaches at the denser grid.
	const [fontSize, setFontSize] = useState(FONT_SIZE);
	// A terminated session has no live PTY (the mux answers "Session not found").
	// Track that + the known status so we can offer Restore instead of a dead term.
	const [notFound, setNotFound] = useState(false);
	const [restoring, setRestoring] = useState(false);
	// In-app browser: shows the static preview file the agent generated (an
	// index.html). We poll the daemon's on-demand detector while the terminal is
	// open and AUTO-OPEN a WebView overlay the first time one appears. The user can
	// close it and keep prompting; we won't re-pop the same file (autoOpenedRef
	// remembers what we've already surfaced).
	const [browserOpen, setBrowserOpen] = useState(false);
	const [preview, setPreview] = useState<{ entry: string; url: string } | null>(null);
	const previewWebRef = useRef<WebView>(null);
	const autoOpenedRef = useRef<string | null>(null);

	const { sessions, orchestrators, restore } = useApp();
	const known = sessions.find((s) => s.id === id) ?? orchestrators.find((o) => o.id === id) ?? null;
	const dead = notFound || (known ? isTerminalStatus(known.status) : false);

	// iOS doesn't resize the layout when the keyboard opens, so the key bar would
	// hide behind it - reserve kbHeight so the bar rides above the keyboard.
	// (Android's adjustResize shrinks the window for us, so no height needed there.)
	useEffect(() => {
		const isIOS = Platform.OS === "ios";
		const showEvt = isIOS ? "keyboardWillShow" : "keyboardDidShow";
		const hideEvt = isIOS ? "keyboardWillHide" : "keyboardDidHide";
		const show = Keyboard.addListener(showEvt, (e) => {
			setKbVisible(true);
			if (isIOS) setKbHeight(e.endCoordinates.height);
		});
		const hide = Keyboard.addListener(hideEvt, () => {
			setKbVisible(false);
			setKbHeight(0);
		});
		// willShow can report a height that still includes the accessory bar we hid,
		// leaving a gap. didShow reports the actual final frame - use it to correct.
		const didShow = isIOS ? Keyboard.addListener("keyboardDidShow", (e) => setKbHeight(e.endCoordinates.height)) : null;
		// Backup: guarantee the reserved space collapses even if willHide is missed.
		const didHide = Keyboard.addListener("keyboardDidHide", () => {
			setKbVisible(false);
			setKbHeight(0);
		});
		return () => {
			show.remove();
			hide.remove();
			didShow?.remove();
			didHide.remove();
		};
	}, []);

	// Header shows just the short id; Kill lives in our own status bar below so we
	// fully control its shape/alignment (iOS draws its own box behind header
	// buttons, which fights any custom background).
	useLayoutEffect(() => {
		navigation.setOptions({
			title: id.length > 22 ? `${id.slice(0, 20)}...` : id,
			// Always render our own Back control so it works even when the app was
			// cold-started directly on this route (reload/deep link) and the stack
			// has no history for the default back button to use.
			headerLeft: () => (
				<Pressable onPress={leave} hitSlop={12} style={styles.headerBack}>
					<Feather name="chevron-left" size={22} color={theme.blue} />
					<Text style={styles.headerBackText}>Back</Text>
				</Pressable>
			),
		});
	}, [navigation, id, leave]);

	// Load config, then connect the mux socket.
	useEffect(() => {
		let disposed = false;
		(async () => {
			const config = await loadConfig();
			if (disposed) return;
			setCfg(config);
			if (!isConfigured(config)) return;

			const mux = new MuxClient(config, {
				onStatus: (s) => setStatus(s),
				onTerminalData: (tid, bytes) => {
					if (tid === id) xtermRef.current?.write(bytes);
				},
				onTerminalExited: (tid, code) => {
					if (tid === id) {
						setBanner(`Session exited (code ${code})`);
						setNotFound(true);
					}
				},
				onTerminalError: (tid, msg) => {
					if (tid !== id) return;
					// A missing PTY means the session is terminated - offer Restore
					// instead of surfacing it as a raw error banner.
					if (/not found/i.test(msg)) setNotFound(true);
					else setBanner(msg);
				},
			});
			muxRef.current = mux;
			mux.connect();
		})();
		return () => {
			disposed = true;
			muxRef.current?.disconnect();
			muxRef.current = null;
		};
	}, [id]);

	// Poll for a generated preview (index.html) and auto-open it the first time it
	// appears. Detection is on-demand server-side, so we re-check on an interval;
	// once we've auto-opened a given URL we never force it open again, so closing
	// the browser to keep prompting sticks. Manual reopen via the globe still works.
	useEffect(() => {
		if (!cfg || !isConfigured(cfg)) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			try {
				const p = await getPreview(cfg, id);
				if (cancelled) return;
				setPreview(p);
				if (p && autoOpenedRef.current !== p.url) {
					autoOpenedRef.current = p.url;
					setBrowserOpen(true);
				}
			} catch {
				/* transient - keep polling */
			}
			if (!cancelled) timer = setTimeout(tick, 5000);
		};
		tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [cfg, id]);

	// The WebView's FitAddon measures the real cell size and reports the resulting
	// cols/rows back through fressh's debug->logger.log channel. We forward those
	// exact dims to the PTY so the display and the PTY always agree, regardless of
	// font, DPR, or accessibility text scale.
	const applyDims = useCallback(
		(cols: number, rows: number) => {
			lastDimsRef.current = { cols, rows };
			setSize((prev) => (prev && prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
			if (openedRef.current) muxRef.current?.resize(id, cols, rows, projectId);
		},
		[id, projectId],
	);

	// fressh routes WebView {type:'debug'} messages to logger.log(prefix, message).
	// We piggyback on it for the FRESSH_DIMS report (using a custom onMessage would
	// clobber fressh's own bridge).
	const logger = useMemo(
		() => ({
			log: (...args: unknown[]) => {
				const m = args[args.length - 1];
				if (typeof m === "string" && m.startsWith("FRESSH_DIMS ")) {
					const parts = m.split(" ");
					const cols = parseInt(parts[1], 10);
					const rows = parseInt(parts[2], 10);
					if (cols > 0 && rows > 0) applyDims(cols, rows);
				}
			},
		}),
		[applyDims],
	);

	const onInitialized = useCallback(() => {
		// Guard against a second open if the WebView re-fires onInitialized (e.g.
		// remount on orientation change) - that would attach the PTY twice.
		if (openedRef.current) return;
		openedRef.current = true;
		muxRef.current?.openTerminal(id, projectId);
		// If the FitAddon already reported dims before open, send them to the PTY now.
		const d = lastDimsRef.current;
		if (d) muxRef.current?.resize(id, d.cols, d.rows, projectId);
	}, [id, projectId]);

	const onData = useCallback(
		(data: string) => {
			muxRef.current?.sendInput(id, data, projectId);
		},
		[id, projectId],
	);

	const sendKey = useCallback(
		(seq: string) => {
			muxRef.current?.sendInput(id, seq, projectId);
		},
		[id, projectId],
	);

	// Show/hide the keyboard by focusing/blurring our RN input (fully reliable,
	// unlike the WebView's keyboard).
	const toggleKeyboard = useCallback(() => {
		if (kbVisible) kbInputRef.current?.blur();
		else kbInputRef.current?.focus();
	}, [kbVisible]);

	// Each key press in the hidden input -> the matching byte(s) to the PTY.
	const onKeyPress = useCallback(
		(e: { nativeEvent: { key: string } }) => {
			const k = e.nativeEvent.key;
			const seq = NAMED_KEYS[k] ?? (k.length === 1 ? k : null);
			if (seq !== null) muxRef.current?.sendInput(id, seq, projectId);
		},
		[id, projectId],
	);

	// High-level message to the agent (AO's /send) - distinct from raw keystrokes.
	const sendPrompt = useCallback(async () => {
		const text = msg.trim();
		if (!text) return;
		setSending(true);
		try {
			const config = cfg ?? (await loadConfig());
			await sendMessage(config, id, text);
			setMsg("");
			setCompose(false);
		} catch (e) {
			setBanner(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSending(false);
		}
	}, [msg, cfg, id]);

	// Toggle the in-app browser. The poll above keeps `preview` current, so a tap
	// just shows/hides the overlay. If nothing's been generated yet, explain that.
	const toggleBrowser = useCallback(() => {
		if (browserOpen) {
			setBrowserOpen(false);
			return;
		}
		if (!preview) {
			setBanner("No preview yet - waiting for the agent to write an index.html...");
			return;
		}
		setBrowserOpen(true);
	}, [browserOpen, preview]);

	const confirmKill = useCallback(() => {
		const doKill = async () => {
			try {
				const config = cfg ?? (await loadConfig());
				await killSession(config, id);
				leave();
			} catch (e) {
				setBanner(`Kill failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		if (Platform.OS === "web") {
			doKill();
			return;
		}
		Alert.alert("Kill session?", `This stops ${id}.`, [
			{ text: "Cancel", style: "cancel" },
			{ text: "Kill", style: "destructive", onPress: doKill },
		]);
	}, [cfg, id, leave]);

	// Restore a terminated session: the daemon re-attaches its worktree agent and
	// its PTY comes back, so we re-open the terminal once restore succeeds.
	const onRestore = useCallback(async () => {
		setRestoring(true);
		try {
			await restore(id);
			setBanner(null);
			setNotFound(false);
			openedRef.current = false;
			// Give the daemon a moment to bring the PTY up, then re-attach.
			setTimeout(() => {
				if (openedRef.current) return;
				openedRef.current = true;
				muxRef.current?.openTerminal(id, projectId);
				const d = lastDimsRef.current;
				if (d) muxRef.current?.resize(id, d.cols, d.rows, projectId);
			}, 1200);
		} catch (e) {
			setBanner(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setRestoring(false);
		}
	}, [restore, id, projectId]);

	const xtermOptions = useMemo(
		() => ({
			fontSize,
			cursorBlink: true,
			scrollback: 5000,
			// Move more rows per swipe so touch scrolling feels responsive.
			scrollSensitivity: 3,
			fastScrollSensitivity: 8,
			theme: {
				background: theme.term,
				foreground: theme.textPrimary,
				cursor: theme.orange,
			},
		}),
		[fontSize],
	);

	// Zoom re-mounts the terminal at a new font size (see fontSize note above).
	// Reset open/size so the fresh mount re-attaches the PTY and re-reports dims.
	const zoom = useCallback((delta: number) => {
		setFontSize((f) => Math.min(20, Math.max(7, f + delta)));
		openedRef.current = false;
		setSize(null);
	}, []);

	const webViewOptions = useMemo(
		() => ({
			// Removes the extra "< > Done" / autofill bar iOS shows above the keyboard.
			hideKeyboardAccessoryView: true,
			// Custom drag/momentum scroll + input hardening (see TERMINAL_ENHANCE_JS).
			// Prepend the platform flag the enhance script branches on for scrolling.
			injectedJavaScript: `var IS_ANDROID=${Platform.OS === "android"};\n${TERMINAL_ENHANCE_JS}`,
			androidLayerType: "hardware" as const,
			nestedScrollEnabled: true,
		}),
		[],
	);

	if (cfg && !isConfigured(cfg)) {
		return (
			<View style={styles.center}>
				<Text style={styles.bannerText}>No server configured.</Text>
			</View>
		);
	}

	// The composer and key bar sit directly atop each other, so they share one
	// bottom inset: reserve room above the keyboard, else the home-indicator inset.
	const bottomPad = kbHeight > 0 ? 8 : insets.bottom > 0 ? insets.bottom : 8;

	return (
		<View style={[styles.screen, Platform.OS === "ios" && { paddingBottom: kbHeight }]}>
			<TextInput
				ref={kbInputRef}
				value=""
				onKeyPress={onKeyPress}
				onChangeText={() => {}}
				blurOnSubmit={false}
				multiline={false}
				autoCapitalize="none"
				autoCorrect={false}
				autoComplete="off"
				spellCheck={false}
				keyboardAppearance="dark"
				caretHidden
				style={styles.kbInput}
			/>
			<View style={styles.statusBar}>
				<View style={[styles.statusDot, { backgroundColor: statusColors[status] }]} />
				<Text style={styles.statusText}>{statusLabel[status]}</Text>
				{size && !dead && (
					<Text style={styles.dims}>
						{size.cols}x{size.rows}
					</Text>
				)}
				{/* In-app browser toggle - shows the agent's generated preview file.
				    Brighter when one is available; auto-opens on first detection. */}
				<Pressable
					hitSlop={8}
					onPress={toggleBrowser}
					style={({ pressed }) => [
						styles.browserBtn,
						browserOpen && styles.browserBtnActive,
						pressed && { opacity: 0.6 },
					]}
				>
					<Feather
						name="globe"
						size={13}
						color={browserOpen ? theme.blue : preview ? theme.textPrimary : theme.textSecondary}
					/>
				</Pressable>
				{dead ? (
					<Pressable
						hitSlop={8}
						onPress={onRestore}
						disabled={restoring}
						style={({ pressed }) => [styles.restoreBtn, (pressed || restoring) && { opacity: 0.7 }]}
					>
						<Feather name="rotate-ccw" size={12} color={theme.blue} />
						<Text style={styles.restoreText}>{restoring ? "Restoring..." : "Restore"}</Text>
					</Pressable>
				) : (
					<Pressable
						hitSlop={8}
						onPress={confirmKill}
						style={({ pressed }) => [styles.killBtn, pressed && { opacity: 0.7 }]}
					>
						<Feather name="x" size={12} color={theme.red} />
						<Text style={styles.killText}>Kill</Text>
					</Pressable>
				)}
			</View>

			{banner && (
				<Pressable onPress={() => setBanner(null)} style={styles.banner}>
					<Text style={styles.bannerText}>{banner} (tap to dismiss)</Text>
				</Pressable>
			)}

			<View style={styles.termWrap}>
				<XtermJsWebView
					key={`term-${fontSize}`}
					ref={xtermRef}
					autoFit={false}
					xtermOptions={xtermOptions}
					webViewOptions={webViewOptions}
					logger={logger}
					onInitialized={onInitialized}
					onData={onData}
					style={{ flex: 1, backgroundColor: theme.bgBase }}
				/>
				{dead && (
					<View style={styles.deadOverlay}>
						<View style={styles.deadIcon}>
							<Feather name="power" size={24} color={theme.textTertiary} />
						</View>
						<Text style={styles.deadTitle}>Session terminated</Text>
						<Text style={styles.deadMsg}>This session has no live terminal. Restore it to bring the agent back.</Text>
						<Pressable
							onPress={onRestore}
							disabled={restoring}
							style={({ pressed }) => [styles.restoreCta, (pressed || restoring) && { opacity: 0.8 }]}
						>
							<Feather name="rotate-ccw" size={16} color="#06101f" />
							<Text style={styles.restoreCtaText}>{restoring ? "Restoring..." : "Restore session"}</Text>
						</Pressable>
					</View>
				)}

				{/* In-app browser overlay: the agent's generated preview file. Sits over
				    the terminal (which keeps running underneath) with its own bar. */}
				{browserOpen && preview && (
					<View style={styles.browserOverlay}>
						<View style={styles.browserBar}>
							<Feather name="globe" size={13} color={theme.textTertiary} />
							<Text style={styles.browserPath} numberOfLines={1}>
								{preview.entry}
							</Text>
							<Pressable hitSlop={8} onPress={() => previewWebRef.current?.reload()} style={styles.browserAction}>
								<Feather name="rotate-cw" size={15} color={theme.blue} />
							</Pressable>
							<Pressable hitSlop={8} onPress={() => setBrowserOpen(false)} style={styles.browserAction}>
								<Feather name="x" size={17} color={theme.textSecondary} />
							</Pressable>
						</View>
						<WebView
							ref={previewWebRef}
							source={{ uri: preview.url }}
							originWhitelist={["*"]}
							style={styles.browserWeb}
							onError={() => setBanner("Preview failed to load.")}
						/>
					</View>
				)}
			</View>

			{compose && (
				<View style={[styles.composer, { paddingBottom: bottomPad }]}>
					<TextInput
						style={styles.composerInput}
						value={msg}
						onChangeText={setMsg}
						placeholder="Message the agent..."
						placeholderTextColor={theme.textTertiary}
						autoFocus
						multiline
						keyboardAppearance="dark"
						onSubmitEditing={sendPrompt}
					/>
					<Pressable
						style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.8 }, !msg.trim() && { opacity: 0.4 }]}
						onPress={sendPrompt}
						disabled={!msg.trim() || sending}
					>
						<Feather name="send" size={16} color="#06101f" />
					</Pressable>
				</View>
			)}

			<View style={[styles.keys, { paddingBottom: bottomPad }]}>
				{EXTRA_KEYS.map((k) => (
					<Pressable
						key={k.label}
						style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
						onPress={() => sendKey(k.seq)}
					>
						<Text style={styles.keyText}>{k.label}</Text>
					</Pressable>
				))}
				{/* Zoom the terminal font: smaller = more rows/cols (see more of a TUI). */}
				<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => zoom(-1)}>
					<Feather name="zoom-out" size={15} color={theme.textPrimary} />
				</Pressable>
				<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => zoom(1)}>
					<Feather name="zoom-in" size={15} color={theme.textPrimary} />
				</Pressable>
				{/* Compose a high-level message to the agent. */}
				<Pressable
					style={({ pressed }) => [styles.key, compose && styles.keyToggle, pressed && styles.keyPressed]}
					onPress={() => setCompose((c) => !c)}
				>
					<Feather name="message-square" size={15} color={compose ? theme.blue : theme.textPrimary} />
				</Pressable>
				{/* Show/hide the keyboard (replaces the OS "Done" button we removed). */}
				<Pressable
					style={({ pressed }) => [styles.key, styles.keyToggle, pressed && styles.keyPressed]}
					onPress={toggleKeyboard}
				>
					<Text style={styles.keyText}>{kbVisible ? "⌨▾" : "⌨▴"}</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: theme.bgBase,
	},
	statusBar: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		paddingVertical: 6,
		borderBottomWidth: 1,
		borderBottomColor: theme.borderSubtle,
	},
	statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
	statusText: { color: theme.textSecondary, fontSize: 12, flex: 1 },
	dims: { color: theme.textTertiary, fontSize: 11, fontFamily: theme.fontMono },
	banner: {
		backgroundColor: theme.bgElevated,
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderBottomColor: theme.borderDefault,
	},
	bannerText: { color: theme.attention, fontSize: 12 },
	termWrap: { flex: 1, backgroundColor: theme.bgBase },
	keys: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 6,
		paddingHorizontal: 8,
		paddingTop: 8,
		borderTopWidth: 1,
		borderTopColor: theme.borderSubtle,
		backgroundColor: theme.bgSurface,
	},
	key: {
		backgroundColor: theme.bgElevated,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		borderRadius: 6,
		paddingVertical: 8,
		paddingHorizontal: 12,
		minWidth: 44,
		alignItems: "center",
	},
	keyPressed: { backgroundColor: theme.accentTint, borderColor: theme.accent },
	keyToggle: { borderColor: theme.accent, marginLeft: "auto" },
	kbInput: { position: "absolute", width: 1, height: 1, top: 0, left: 0, opacity: 0 },
	keyText: { color: theme.textPrimary, fontFamily: theme.fontMono, fontSize: 14 },
	killBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		backgroundColor: theme.tintRed,
		borderRadius: 12,
		paddingHorizontal: 11,
		paddingVertical: 4,
		marginLeft: 12,
	},
	killText: { color: theme.red, fontWeight: "700", fontSize: 12 },
	browserBtn: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: theme.bgElevated,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		borderRadius: 12,
		paddingHorizontal: 10,
		paddingVertical: 4,
		marginLeft: 12,
	},
	browserBtnActive: { backgroundColor: theme.tintBlue, borderColor: theme.blue },
	browserOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.bgBase },
	browserBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 8,
		backgroundColor: theme.bgSurface,
		borderBottomWidth: 1,
		borderBottomColor: theme.borderSubtle,
	},
	browserPath: { flex: 1, color: theme.textSecondary, fontFamily: theme.fontMono, fontSize: 12 },
	browserAction: { paddingHorizontal: 4, paddingVertical: 2 },
	browserWeb: { flex: 1, backgroundColor: "#ffffff" },
	headerBack: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
	headerBackText: { color: theme.blue, fontSize: 17, marginLeft: 2 },
	restoreBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		backgroundColor: theme.tintBlue,
		borderRadius: 12,
		paddingHorizontal: 11,
		paddingVertical: 4,
		marginLeft: 12,
	},
	restoreText: { color: theme.blue, fontWeight: "700", fontSize: 12 },
	deadOverlay: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		padding: 32,
		gap: 10,
		backgroundColor: theme.bgBase,
	},
	deadIcon: {
		width: 64,
		height: 64,
		borderRadius: 18,
		backgroundColor: theme.bgElevated,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		alignItems: "center",
		justifyContent: "center",
		marginBottom: 6,
	},
	deadTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
	deadMsg: { color: theme.textSecondary, fontSize: 13, lineHeight: 20, textAlign: "center", maxWidth: 300 },
	restoreCta: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		backgroundColor: theme.blue,
		borderRadius: 10,
		paddingVertical: 12,
		paddingHorizontal: 20,
		marginTop: 10,
	},
	restoreCtaText: { color: "#06101f", fontSize: 15, fontWeight: "700" },
	composer: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 8,
		paddingHorizontal: 10,
		paddingTop: 8,
		backgroundColor: theme.bgSurface,
		borderTopWidth: 1,
		borderTopColor: theme.borderSubtle,
	},
	composerInput: {
		flex: 1,
		backgroundColor: theme.bgElevated,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		borderRadius: 10,
		color: theme.textPrimary,
		paddingHorizontal: 12,
		paddingVertical: 9,
		fontSize: 14,
		maxHeight: 110,
	},
	sendBtn: {
		width: 40,
		height: 40,
		borderRadius: 10,
		backgroundColor: theme.blue,
		alignItems: "center",
		justifyContent: "center",
	},
});
