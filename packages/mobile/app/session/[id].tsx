import { Feather } from "@expo/vector-icons";
import { XtermJsWebView, type XtermWebViewHandle } from "@fressh/react-native-xtermjs-webview";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { getPreview, isTerminalStatus, killSession, sendMessage } from "../../lib/api";
import { authHeaders, isConfigured, loadConfig, type ServerConfig } from "../../lib/config";
import { haptics } from "../../lib/haptics";
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
    '.xterm-viewport{pointer-events:auto !important;-webkit-overflow-scrolling:touch !important;}' +
    // We drive scrolling ourselves, so the WebView scrollbar is pure wasted width
    // on the right. Hide it (and give the viewport a thin overlay one) so the fit
    // reclaims those pixels as extra columns instead of a gap.
    '.xterm-viewport{scrollbar-width:none !important;}' +
    '.xterm-viewport::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}';
  document.head.appendChild(s);

  // Report xterm's REAL grid size (measured by the FitAddon from the actual
  // rendered cell) back to RN through fressh's own debug channel, so RN can tell
  // the PTY the exact cols/rows xterm is using — no font/DPR guessing.
  // Report the phone's NATURAL fit (what would fill the screen at the current
  // font) WITHOUT resizing the terminal. The render grid is driven by the daemon
  // (the shared PTY's authoritative size), which we scale to fit below; we report
  // this fit only so the daemon can size the PTY to the phone when it is the sole
  // viewer. proposeDimensions measures without applying, unlike fit().
  function reportFit() {
    try {
      var F = window.fitAddon; if (!F || !F.proposeDimensions) return;
      // xterm can't measure a real scrollbar on mobile (overlay scrollbars are
      // 0px, so its "offsetWidth - offsetWidth || 15" falls back to assuming a
      // 15px one). proposeDimensions subtracts that phantom width and under-reports
      // cols, leaving a dead strip on the right. We drive our own scroll and hide
      // the bar (see injected CSS above), so zero it before measuring to reclaim
      // those columns for the fit.
      try {
        var vp = window.terminal && window.terminal._core && window.terminal._core.viewport;
        if (vp) vp.scrollBarWidth = 0;
      } catch (_) {}
      var d = F.proposeDimensions();
      if (d && d.cols > 0 && d.rows > 0 && window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'debug', message: 'FRESSH_DIMS ' + d.cols + ' ' + d.rows }));
      }
    } catch (_) {}
  }

  // ---- Zoom & pan -----------------------------------------------------------
  // The daemon may hold the grid wider than the phone (a co-viewing desktop
  // drives the size). The resting view shrinks the whole grid uniformly to fit
  // the width (overview — may be tiny). Pinch zooms between that fit scale and
  // 1:1 (crisp, readable); while zoomed, one finger pans the viewport (vertical
  // overshoot spills into scrollback) and double-tap toggles overview <-> 1:1.
  // While zoomed we auto-pan to keep the cursor framed, so the prompt/output
  // stays in view without chasing it by hand.
  function term() { return window.terminal; }
  var Z = { s: 1, min: 1, tx: 0, ty: 0, zoomed: false, lastPan: 0 };
  function box() {
    var root = document.querySelector('.xterm');
    var screen = document.querySelector('.xterm-screen');
    var host = document.getElementById('terminal') || document.body;
    if (!root || !screen || !host) return null;
    return { root: root, natW: screen.offsetWidth, natH: screen.offsetHeight,
             contW: host.clientWidth || window.innerWidth,
             contH: host.clientHeight || window.innerHeight };
  }
  function clampT(b) {
    var minTx = Math.min(0, b.contW - b.natW * Z.s);
    var minTy = Math.min(0, b.contH - b.natH * Z.s);
    if (Z.tx < minTx) Z.tx = minTx; if (Z.tx > 0) Z.tx = 0;
    if (Z.ty < minTy) Z.ty = minTy; if (Z.ty > 0) Z.ty = 0;
  }
  function applyTransform(b) {
    b.root.style.transformOrigin = 'top left';
    b.root.style.transform = 'translate(' + Z.tx + 'px,' + Z.ty + 'px) scale(' + Z.s + ')';
  }
  // Fit-to-width baseline, re-run on grid/container changes. Tracks the fit
  // scale while at overview; preserves (re-clamps) the user's zoom otherwise.
  function applyScale() {
    try {
      var b = box(); if (!b || !b.natW || !b.contW) return;
      Z.min = Math.min(1, b.contW / b.natW);
      if (!Z.zoomed) { Z.s = Z.min; Z.tx = 0; Z.ty = 0; }
      else { if (Z.s < Z.min) Z.s = Z.min; clampT(b); }
      applyTransform(b);
    } catch (_) {}
  }
  // Zoom to scale s keeping the content under screen point (ax, ay) fixed.
  function setZoom(s, ax, ay) {
    var b = box(); if (!b) return;
    if (s < Z.min) s = Z.min; if (s > 1) s = 1;
    var px = (ax - Z.tx) / Z.s, py = (ay - Z.ty) / Z.s;
    Z.s = s; Z.tx = ax - px * s; Z.ty = ay - py * s;
    Z.zoomed = s > Z.min + 0.001;
    if (!Z.zoomed) { Z.s = Z.min; Z.tx = 0; Z.ty = 0; }
    clampT(b); applyTransform(b);
  }
  // Auto-pan so the cursor stays framed while zoomed in. Backs off for a few
  // seconds after a manual pan/pinch (never fight the finger) and only follows
  // the live screen — not while the user is reading scrollback.
  function followCursor() {
    try {
      if (!Z.zoomed || Date.now() - Z.lastPan < 4000) return;
      var T = term(); var b = box(); if (!T || !b || !T.cols || !T.rows) return;
      var buf = T.buffer && T.buffer.active; if (!buf) return;
      if (buf.viewportY !== buf.baseY) return;
      var cx = (buf.cursorX + 0.5) * (b.natW / T.cols) * Z.s;
      var cy = (buf.cursorY + 0.5) * (b.natH / T.rows) * Z.s;
      var mX = Math.min(48, b.contW / 4), mY = Math.min(48, b.contH / 4);
      if (Z.tx + cx < mX) Z.tx = mX - cx;
      else if (Z.tx + cx > b.contW - mX) Z.tx = b.contW - mX - cx;
      if (Z.ty + cy < mY) Z.ty = mY - cy;
      else if (Z.ty + cy > b.contH - mY) Z.ty = b.contH - mY - cy;
      clampT(b); applyTransform(b);
    } catch (_) {}
  }

  // When the grid changes, keep it pinned to the bottom (latest output).
  function pinBottom() { try { window.terminal.scrollToBottom(); } catch (_) {} }
  var cfTimer = 0;
  (function wire() {
    if (window.terminal && window.terminal.onResize && window.fitAddon) {
      // The grid changes only when the daemon tells RN the authoritative size and
      // RN calls resize(); re-fit-to-width and pin on every such change.
      window.terminal.onResize(function () { setTimeout(function () { applyScale(); pinBottom(); }, 0); });
      // Throttled cursor-follow: cursor moves fire in bursts while output streams.
      if (window.terminal.onCursorMove) {
        window.terminal.onCursorMove(function () {
          if (cfTimer) return;
          cfTimer = setTimeout(function () { cfTimer = 0; followCursor(); }, 120);
        });
      }
      // On box changes (keyboard/rotation) re-report the fit and re-scale, but do
      // NOT fit() — the daemon owns the grid; fitting would fight it.
      try {
        var host = document.getElementById('terminal') || document.body;
        var ro = new ResizeObserver(function () { reportFit(); applyScale(); });
        ro.observe(host);
      } catch (_) {}
      reportFit(); applyScale();
      // Android's first measure often runs before layout/fonts settle, so the grid
      // comes out narrower than the WebView until some later resize nudges it. Since
      // nothing changes the host box in between (the ResizeObserver never fires until
      // e.g. the keyboard opens), re-measure a few times as things settle so the fit
      // reaches full width on its own.
      [60, 200, 500, 1000].forEach(function (t) {
        setTimeout(function () { reportFit(); applyScale(); }, t);
      });
    } else {
      setTimeout(wire, 200);
    }
  })();

  // Keyboard is handled by a React-Native TextInput, NOT the WebView. We disable
  // the WebView's hidden textarea (see harden) so it can never raise a keyboard
  // or steal first-responder. The keyboard button shows/hides the keyboard.

  // Gesture routing (canvas is pointer-events:none, so we read touches here):
  //  • quick drag -> scrollback scroll (overview) / viewport pan (zoomed)
  //  • pinch -> zoom between fit-to-width and 1:1
  //  • long-press -> select the line; drag extends by lines; release copies
  //  • single tap -> nothing   • double-tap -> toggle overview <-> 1:1
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

  // ---- App-driven scrolling (harness-agnostic) ------------------------------
  // Full-screen TUIs (Claude Code, Codex, Gemini, aider, vim, less, ...) run in
  // the terminal's ALTERNATE screen buffer, which by design keeps NO xterm
  // scrollback — so .xterm-viewport has nothing to scroll and a drag "does
  // nothing". Rather than hand-encode scroll bytes per harness, we synthesize the
  // same 'wheel' event a desktop mouse produces and let xterm's own handler
  // translate it for WHATEVER the app negotiated: proper mouse-wheel bytes when
  // the app tracks the mouse (X10/UTF-8/SGR — xterm picks the right encoding),
  // else cursor-key presses (honoring application-cursor mode) in the alt buffer.
  // This means it works for every harness, not just one. The normal buffer (plain
  // shell scrollback) keeps its local viewport scroll below.
  function isAltScreen() {
    try { var b = term().buffer.active; return !!(b && b.type === 'alternate'); }
    catch (_) { return false; }
  }
  function mouseActive() {
    try { var m = term().modes; return !!(m && m.mouseTrackingMode && m.mouseTrackingMode !== 'none'); }
    catch (_) { return false; }
  }
  // Let xterm own the scroll only where a local viewport scroll wouldn't reach the
  // app: the alt buffer (no scrollback) or any buffer where the app tracks mouse.
  function appDrivesScroll() { return isAltScreen() || mouseActive(); }
  // Dispatch one wheel notch to xterm (up = toward older output). Coordinates are
  // the finger position so mouse-reporting apps get an accurate cell.
  function wheelTick(up, cx, cy) {
    var el = document.querySelector('.xterm'); if (!el) return;
    var ev;
    try {
      ev = new WheelEvent('wheel', { bubbles: true, cancelable: true,
        deltaX: 0, deltaY: up ? -1 : 1, deltaZ: 0,
        deltaMode: 1 /* DOM_DELTA_LINE */, clientX: cx, clientY: cy });
    } catch (_) {
      ev = document.createEvent('Event'); ev.initEvent('wheel', true, true);
      ev.deltaY = up ? -1 : 1; ev.deltaMode = 1; ev.clientX = cx; ev.clientY = cy;
    }
    el.dispatchEvent(ev);
  }

  var sX = 0, sY = 0, mode = 'idle', anchor = 0, lpTimer = 0;
  var MOVE = 10, LONGPRESS = 350, DBLTAP = 300;
  var altLines = 0;                        // wheel notches emitted to the app this gesture
  var SCROLL_STEP_PX = 24;                 // finger px per wheel notch (scale-independent)
  // Android: we drive the viewport's scrollTop directly off finger movement —
  // its native overflow-scroll doesn't respond to touch reliably in the WebView,
  // which is why the terminal felt unscrollable there. iOS keeps native momentum.
  var _vp = null, startScroll = 0;
  var lX = 0, lY = 0;                       // last touch point (zoomed pan deltas)
  var pinch0 = null;                        // pinch anchor {d, s, mx, my}
  var lastTap = 0, ltX = 0, ltY = 0;        // double-tap detection
  function clearLP() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } }
  function touchDist(e) {
    var a = e.touches[0], b = e.touches[1];
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  document.addEventListener('touchstart', function (e) {
    // Taps on the scroll-to-top button are handled by the button itself; don't
    // let this capture-phase listener consume them as a terminal tap/long-press.
    var _tt = e.target;
    if (_tt && _tt.closest && _tt.closest('#ao-scrolltop')) return;
    if (e.touches && e.touches.length >= 2) {
      // Second finger down -> pinch. Cancel any pending tap/long-press/scroll.
      clearLP(); mode = 'pinch';
      pinch0 = { d: touchDist(e) || 1, s: Z.s,
                 mx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                 my: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      try { term() && term().clearSelection(); } catch (_) {}
      return;
    }
    var t = e.touches ? e.touches[0] : e;
    sX = t.clientX; sY = t.clientY; lX = sX; lY = sY; mode = 'pending';
    altLines = 0;
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
    if (mode === 'pinch') {
      if (!e.touches || e.touches.length < 2 || !pinch0) return;
      if (e.cancelable) e.preventDefault();  // keep the page/viewport from moving
      var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      // Two-finger drag pans while pinching; the scale keeps the content under
      // the midpoint anchored so the zoom feels centered on the fingers.
      Z.tx += mx - pinch0.mx; Z.ty += my - pinch0.my;
      setZoom(pinch0.s * (touchDist(e) / pinch0.d), mx, my);
      pinch0.mx = mx; pinch0.my = my;
      Z.lastPan = Date.now();
      return;
    }
    var t = e.touches ? e.touches[0] : e;
    if (mode === 'pending') {
      if (Math.abs(t.clientX - sX) > MOVE || Math.abs(t.clientY - sY) > MOVE) {
        mode = 'scroll'; clearLP(); lX = t.clientX; lY = t.clientY;
      }
      return;
    }
    if (mode === 'scroll') {
      if (appDrivesScroll()) {
        // The app owns scrolling here (alt buffer / mouse tracking): feed it wheel
        // notches instead of moving the (empty) xterm viewport. Content follows the
        // finger (drag down -> older), matching the normal buffer's direction below.
        // One notch per SCROLL_STEP_PX of travel; emit only on each boundary cross.
        if (e.cancelable) e.preventDefault();
        var moved = (t.clientY - sY) / SCROLL_STEP_PX;   // + = finger down = older
        var want = moved > 0 ? Math.floor(moved) : Math.ceil(moved);
        var diff = want - altLines;
        if (diff !== 0) {
          var up = diff > 0;                             // more "older" notches -> wheel up
          for (var i = 0; i < Math.abs(diff); i++) wheelTick(up, t.clientX, t.clientY);
          altLines = want;
        }
        // While zoomed, the horizontal component still pans the magnified grid.
        if (Z.zoomed) {
          var bz = box();
          if (bz) { Z.tx += t.clientX - lX; clampT(bz); applyTransform(bz); Z.lastPan = Date.now(); }
        }
        lX = t.clientX; lY = t.clientY;
        return;
      }
      if (Z.zoomed) {
        // Zoomed in: one finger pans the viewport over the big grid. Vertical
        // overshoot past the grid edge spills into scrollback scrolling (divide
        // by scale: scrollTop is in unscaled content px, the finger in screen px).
        if (e.cancelable) e.preventDefault();
        var b = box();
        if (b) {
          Z.tx += t.clientX - lX;
          var wantTy = Z.ty + (t.clientY - lY);
          Z.ty = wantTy;
          clampT(b);
          var spill = wantTy - Z.ty;
          if (spill !== 0 && _vp) _vp.scrollTop -= spill / Z.s;
          applyTransform(b);
        }
        Z.lastPan = Date.now();
        lX = t.clientX; lY = t.clientY;
        return;
      }
      // Overview: scrollback scroll. Android: move the viewport ourselves, 1:1
      // with the finger. iOS: leave it to native momentum (don't preventDefault).
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

  document.addEventListener('touchend', function (e) {
    clearLP();
    if (mode === 'pinch') {
      // Stay in pinch while two fingers remain; otherwise done (the leftover
      // finger must lift and re-touch to start a new gesture).
      if (!e.touches || e.touches.length < 2) { mode = 'idle'; pinch0 = null; }
      return;
    }
    if (mode === 'select') copySel();
    if (mode === 'pending') {
      // A tap. Two taps close together toggle overview <-> 1:1 at the tap point.
      var now = Date.now();
      if (now - lastTap < DBLTAP && Math.abs(sX - ltX) < 40 && Math.abs(sY - ltY) < 40) {
        lastTap = 0;
        if (Z.zoomed) setZoom(Z.min, 0, 0);
        else { setZoom(1, sX, sY); Z.lastPan = Date.now(); }
      } else { lastTap = now; ltX = sX; ltY = sY; }
    }
    mode = 'idle';
  }, { capture: true, passive: true });

  // ---- Scroll-to-top button ------------------------------------------------
  // A floating button that scrolls back to the oldest output. It lives in the
  // terminal DOM (not RN) because the WebView package exposes no inject hook.
  // Two regimes, mirroring the drag handler above:
  //  • normal buffer  -> xterm owns the scrollback; scrollToTop() is a true jump,
  //    and viewportY tells us whether there's anything above (hide at the top).
  //  • alt buffer / mouse-tracking (Claude Code, Codex, aider, vim, less, ...) ->
  //    the APP owns its scrollback, so scrollToTop() can't reach it. Send the same
  //    wheel notches a drag produces. We can't query the app's scroll position, so
  //    the button always shows there and the jump is a generous burst.
  (function scrollTopBtn() {
    var btn = document.createElement('div');
    btn.id = 'ao-scrolltop';
    btn.setAttribute('aria-label', 'Scroll to top');
    btn.innerHTML = '↑'; // up arrow
    var s = btn.style;
    s.position = 'fixed'; s.right = '12px'; s.bottom = '12px';
    s.width = '36px'; s.height = '36px'; s.lineHeight = '36px';
    s.textAlign = 'center'; s.borderRadius = '18px';
    s.background = 'rgba(20,28,40,0.72)'; s.color = '#dbe4f0';
    s.fontSize = '18px'; s.fontWeight = '600';
    s.border = '1px solid rgba(120,140,170,0.35)';
    s.boxShadow = '0 2px 8px rgba(0,0,0,0.4)';
    s.webkitBackdropFilter = 'blur(6px)'; s.backdropFilter = 'blur(6px)';
    s.zIndex = '2147483647'; s.display = 'none'; s.cursor = 'pointer';
    s.pointerEvents = 'auto'; s.userSelect = 'none'; s.webkitUserSelect = 'none';
    (document.getElementById('terminal') || document.body).appendChild(btn);

    function atTop() {
      try { var b = term().buffer.active; return !b || b.viewportY <= 0; }
      catch (_) { return true; }
    }
    function update() {
      // When the app drives scrolling we can't read its position, so always offer
      // the button; otherwise hide it once xterm's viewport is at the top.
      var show = appDrivesScroll() ? true : !atTop();
      btn.style.display = show ? 'block' : 'none';
    }
    // Walk the app's scrollback up with the same wheel notches a drag produces,
    // chunked across frames so a few hundred events don't block the renderer.
    var TOP_BURST = 400, BURST_CHUNK = 25;
    function burstUp() {
      var el = document.querySelector('.xterm');
      var r = el ? el.getBoundingClientRect() : null;
      var cx = r ? r.left + r.width / 2 : 0;
      var cy = r ? r.top + r.height / 2 : 0;
      var left = TOP_BURST;
      (function step() {
        for (var i = 0; i < BURST_CHUNK && left > 0; i++, left--) wheelTick(true, cx, cy);
        if (left > 0) requestAnimationFrame(step);
      })();
    }
    // Tap -> back to the oldest output. Swallow the event so nothing else reacts.
    function go(e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.cancelable && e.preventDefault) e.preventDefault();
      if (appDrivesScroll()) burstUp();
      else { try { term().scrollToTop(); } catch (_) {} }
      update();
    }
    btn.addEventListener('touchstart', go, { capture: true });
    btn.addEventListener('click', go, { capture: true });

    // Re-evaluate on xterm scroll and buffer switches; poll as a cheap fallback
    // for transitions those miss (our drag handler moves the viewport directly).
    (function wire() {
      var T = term();
      if (T && T.onScroll) {
        T.onScroll(update);
        try { if (T.buffer && T.buffer.onBufferChange) T.buffer.onBufferChange(update); } catch (_) {}
        update();
      } else { setTimeout(wire, 200); }
    })();
    setInterval(update, 500);
  })();

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
	// The authoritative grid the daemon told us the shared PTY is actually using
	// (driven by the largest/primary client — e.g. a co-viewing desktop). We render
	// THIS grid (scaled to fit), not the phone's own fit, so the display matches the
	// PTY and a full-screen TUI doesn't mis-render. Null until the daemon reports it.
	const authRef = useRef<{ cols: number; rows: number } | null>(null);
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
	// open, but we deliberately DO NOT auto-open the overlay: the detector falls back
	// to any previewable file (e.g. a repo's README.md), so auto-popping would steal
	// the screen with an unbuilt/blank page. Instead the globe button lights up with a
	// green dot when the agent has produced something to view (any previewable file
	// except the repo README); the user taps it to open.
	const [browserOpen, setBrowserOpen] = useState(false);
	const [preview, setPreview] = useState<{ entry: string; url: string } | null>(null);
	const previewWebRef = useRef<WebView>(null);

	const { sessions, orchestrators, restore } = useApp();
	const known = sessions.find((s) => s.id === id) ?? orchestrators.find((o) => o.id === id) ?? null;
	const dead = notFound || (known ? isTerminalStatus(known.status) : false);
	// What counts as a live preview: any file the daemon surfaces (an .html build, or
	// a generated doc like plan.md / a report) EXCEPT a repo's README, which the
	// detector's markdown fallback always matches on a fresh checkout. Filtering the
	// README out keeps the globe's green dot meaningful — it means "there's something
	// the agent produced to view", not just "this repo has a README".
	const previewBase = (preview?.entry ?? "").split("/").pop() ?? "";
	const isReadme = /^readme\.(md|markdown)$/i.test(previewBase);
	const hasPreview = !!preview && !isReadme;

	// Neither platform shrinks the layout for the keyboard: iOS never has, and on
	// Android edge-to-edge (edgeToEdgeEnabled) defeats windowSoftInputMode=adjustResize
	// so the window no longer resizes - the keyboard just draws over our content.
	// So reserve kbHeight on BOTH platforms and let the screen pad itself above the
	// keyboard, else the key/compose bar (and its send button) hide behind it.
	useEffect(() => {
		const isIOS = Platform.OS === "ios";
		const showEvt = isIOS ? "keyboardWillShow" : "keyboardDidShow";
		const hideEvt = isIOS ? "keyboardWillHide" : "keyboardDidHide";
		const show = Keyboard.addListener(showEvt, (e) => {
			setKbVisible(true);
			setKbHeight(e.endCoordinates.height);
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
				onTerminalResize: (tid, cols, rows) => {
					if (tid !== id) return;
					// The daemon's authoritative grid: render exactly this (the webview
					// scales it to fit), so the phone mirrors the shared PTY instead of
					// fitting to its own screen and mis-drawing a wider grid.
					authRef.current = { cols, rows };
					setSize({ cols, rows });
					xtermRef.current?.resize({ cols, rows });
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

	// Poll the daemon's on-demand preview detector while the terminal is open, just
	// to keep `preview` current for the globe button. We never auto-open the overlay
	// (see the note by the state above): the detector's markdown fallback matches a
	// repo README, so auto-popping would surface a blank/unbuilt page.
	useEffect(() => {
		if (!cfg || !isConfigured(cfg)) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			try {
				const p = await getPreview(cfg, id);
				if (cancelled) return;
				setPreview(p);
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

	// The WebView reports the phone's NATURAL fit (proposeDimensions, measure-only).
	// We forward it to the daemon as this client's requested size — used only when
	// the phone is the sole viewer (a co-viewing desktop, being primary, wins). The
	// render grid comes back via onTerminalResize; until it does, render the fit so
	// the terminal isn't blank.
	const applyDims = useCallback(
		(cols: number, rows: number) => {
			lastDimsRef.current = { cols, rows };
			if (openedRef.current) muxRef.current?.resize(id, cols, rows, projectId);
			if (!authRef.current) {
				setSize({ cols, rows });
				xtermRef.current?.resize({ cols, rows });
			}
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
		// A fresh xterm (first mount, or a remount after a font-zoom) starts at its
		// default grid — restore the daemon's authoritative grid onto it so it keeps
		// mirroring the shared PTY rather than snapping to the default.
		if (authRef.current) xtermRef.current?.resize(authRef.current);
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
			haptics.success();
			setMsg("");
			setCompose(false);
		} catch (e) {
			haptics.error();
			setBanner(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSending(false);
		}
	}, [msg, cfg, id]);

	// Toggle the in-app browser. The poll above keeps `preview` current, so a tap
	// just shows/hides the overlay. A bare README (the detector's markdown fallback)
	// reports "no preview yet" instead of surfacing an unbuilt repo doc.
	const toggleBrowser = useCallback(() => {
		haptics.tap();
		if (browserOpen) {
			setBrowserOpen(false);
			return;
		}
		if (!hasPreview) {
			setBanner("No preview yet - waiting for the agent to generate a page or document...");
			return;
		}
		setBrowserOpen(true);
	}, [browserOpen, hasPreview]);

	const confirmKill = useCallback(() => {
		const doKill = async () => {
			try {
				const config = cfg ?? (await loadConfig());
				await killSession(config, id);
				haptics.success();
				leave();
			} catch (e) {
				haptics.error();
				setBanner(`Kill failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		if (Platform.OS === "web") {
			doKill();
			return;
		}
		// Cautionary buzz as the destructive confirmation dialog is raised.
		haptics.warning();
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
			// NOTE: do NOT force androidLayerType:"hardware" here. xterm renders into a
			// <canvas>, and a hardware layer makes the Android WebView's render process
			// composite/crash blank on many devices (black terminal, no dims ever
			// reported). Leaving it at the default keeps the canvas visible.
			nestedScrollEnabled: true,
			// Surface an Android WebView render-process crash instead of a silent black
			// screen, so the user can tell the terminal died vs. never loaded.
			onRenderProcessGone: () => setBanner("Terminal renderer crashed - reopen the session (Back, then tap it again)."),
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
		<View style={[styles.screen, kbHeight > 0 && { paddingBottom: kbHeight }]}>
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
				{/* In-app browser toggle - shows a page or doc the agent generated. Goes
				    green with a dot when one is available; tap to open (we never
				    auto-open, so a bare README can't pop a blank page). */}
				<Pressable
					hitSlop={8}
					onPress={toggleBrowser}
					style={({ pressed }) => [
						styles.browserBtn,
						browserOpen && styles.browserBtnActive,
						hasPreview && !browserOpen && styles.browserBtnReady,
						pressed && { opacity: 0.6 },
					]}
				>
					<Feather
						name="globe"
						size={13}
						color={browserOpen ? theme.blue : hasPreview ? theme.green : theme.textSecondary}
					/>
					{hasPreview && !browserOpen && <View style={styles.browserReadyDot} />}
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
							// The preview route lives behind the daemon's connection-password
							// auth (Bearer). Without this header the WebView's request 401s and
							// renders the JSON error body instead of the page. cfg carries the
							// password we paired with; authHeaders() turns it into the Bearer.
							source={{ uri: preview.url, headers: cfg ? authHeaders(cfg) : undefined }}
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
	// A live web preview: tint the pill green so the globe reads as "ready to open".
	browserBtnReady: { backgroundColor: theme.tintGreen, borderColor: theme.green },
	// Small green badge on the globe when a real preview is available.
	browserReadyDot: {
		position: "absolute",
		top: -2,
		right: -2,
		width: 8,
		height: 8,
		borderRadius: 4,
		backgroundColor: theme.green,
		borderWidth: 1,
		borderColor: theme.bgSurface,
	},
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
