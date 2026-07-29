// Pure bounds math ported from `clampBoundsToWindow`/`scaleBoundsForZoom` in
// frontend/src/main/browser-view-host.ts, plus the `browser_set_bounds`
// command (fire-and-forget — the renderer sends already zoom-scaled bounds).

use tauri::{LogicalPosition, LogicalSize, Manager, State};

use super::{BrowserBoundsInput, BrowserRegistry};

/// Parked/hidden panels sit off-screen rather than merely `hide()`-ing, so a
/// stray focus/measure race can never flash them back at (0,0). Mirrors
/// Electron's `OFFSCREEN_BOUNDS`.
pub const OFFSCREEN_X: f64 = -10_000.0;

pub fn scale_bounds_for_zoom(rect: (f64, f64, f64, f64), zoom_factor: f64) -> (f64, f64, f64, f64) {
    if !zoom_factor.is_finite() || zoom_factor <= 0.0 || zoom_factor == 1.0 {
        return rect;
    }
    let (x, y, width, height) = rect;
    (
        x * zoom_factor,
        y * zoom_factor,
        width * zoom_factor,
        height * zoom_factor,
    )
}

pub fn clamp_bounds_to_window(
    rect: (f64, f64, f64, f64),
    window_bounds: (f64, f64),
) -> (f64, f64, f64, f64) {
    let (rx, ry, rw, rh) = rect;
    let rounded_x = rx.round();
    let rounded_y = ry.round();
    let rounded_w = rw.round().max(0.0);
    let rounded_h = rh.round().max(0.0);
    let (window_w, window_h) = window_bounds;
    let max_x = window_w.round().max(0.0);
    let max_y = window_h.round().max(0.0);
    let x = rounded_x.max(0.0).min(max_x);
    let y = rounded_y.max(0.0).min(max_y);
    let width = rounded_w.min((max_x - x).max(0.0));
    let height = rounded_h.min((max_y - y).max(0.0));
    (x, y, width, height)
}

#[tauri::command]
pub fn browser_set_bounds(
    window: tauri::Window,
    state: State<'_, BrowserRegistry>,
    input: BrowserBoundsInput,
) {
    if !state.0.lock().unwrap().contains_key(&input.view_id) {
        return;
    }
    let Some(child) = window.get_webview(&input.view_id) else {
        return;
    };
    // Tauri does not expose the caller's page-zoom factor to a plain command
    // the way Electron's `event.sender.getZoomFactor()` does; page zoom is a
    // renderer (CSS) concern under Tauri (no equivalent of Chromium's
    // WebContents zoom), so the renderer already sends unscaled CSS-pixel
    // bounds and this stays a 1.0 passthrough scale — kept as a named step so
    // a future page-zoom feature only has to change this call site.
    let zoom_factor = 1.0;
    let rect = (
        input.rect.x,
        input.rect.y,
        input.rect.width,
        input.rect.height,
    );

    if input.parked.unwrap_or(false) {
        let (_, _, w, h) = scale_bounds_for_zoom(rect, zoom_factor);
        let width = w.round().max(1.0);
        let height = h.round().max(1.0);
        let _ = child.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
        let _ = child.set_size(LogicalSize::new(width, height));
        let _ = child.show();
        return;
    }

    if !input.visible {
        let _ = child.hide();
        let _ = child.set_position(LogicalPosition::new(OFFSCREEN_X, -10_000.0));
        return;
    }

    let main_bounds = window
        .inner_size()
        .map(|size| {
            let scale = window.scale_factor().unwrap_or(1.0);
            (size.width as f64 / scale, size.height as f64 / scale)
        })
        .unwrap_or((0.0, 0.0));
    let (x, y, width, height) =
        clamp_bounds_to_window(scale_bounds_for_zoom(rect, zoom_factor), main_bounds);
    let _ = child.set_position(LogicalPosition::new(x, y));
    let _ = child.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    if width > 0.0 && height > 0.0 {
        let _ = child.show();
    } else {
        let _ = child.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_bounds_for_zoom_is_a_passthrough_at_default_zoom() {
        assert_eq!(
            scale_bounds_for_zoom((1.0, 2.0, 3.0, 4.0), 1.0),
            (1.0, 2.0, 3.0, 4.0)
        );
    }

    #[test]
    fn scale_bounds_for_zoom_scales_all_fields_uniformly() {
        assert_eq!(
            scale_bounds_for_zoom((10.0, 20.0, 30.0, 40.0), 2.0),
            (20.0, 40.0, 60.0, 80.0)
        );
    }

    #[test]
    fn scale_bounds_for_zoom_ignores_non_finite_or_non_positive_factors() {
        assert_eq!(
            scale_bounds_for_zoom((1.0, 1.0, 1.0, 1.0), 0.0),
            (1.0, 1.0, 1.0, 1.0)
        );
        assert_eq!(
            scale_bounds_for_zoom((1.0, 1.0, 1.0, 1.0), -2.0),
            (1.0, 1.0, 1.0, 1.0)
        );
        assert_eq!(
            scale_bounds_for_zoom((1.0, 1.0, 1.0, 1.0), f64::NAN),
            (1.0, 1.0, 1.0, 1.0)
        );
    }

    #[test]
    fn clamp_bounds_to_window_keeps_an_in_bounds_rect_unchanged() {
        assert_eq!(
            clamp_bounds_to_window((10.0, 10.0, 100.0, 100.0), (800.0, 600.0)),
            (10.0, 10.0, 100.0, 100.0)
        );
    }

    #[test]
    fn clamp_bounds_to_window_clamps_negative_origin_to_zero() {
        assert_eq!(
            clamp_bounds_to_window((-50.0, -20.0, 100.0, 100.0), (800.0, 600.0)),
            (0.0, 0.0, 100.0, 100.0)
        );
    }

    #[test]
    fn clamp_bounds_to_window_shrinks_a_rect_that_overflows_the_window() {
        assert_eq!(
            clamp_bounds_to_window((700.0, 500.0, 200.0, 200.0), (800.0, 600.0)),
            (700.0, 500.0, 100.0, 100.0)
        );
    }

    #[test]
    fn clamp_bounds_to_window_never_produces_negative_size() {
        assert_eq!(
            clamp_bounds_to_window((900.0, 700.0, 50.0, 50.0), (800.0, 600.0)),
            (800.0, 600.0, 0.0, 0.0)
        );
    }

    #[test]
    fn clamp_bounds_to_window_rounds_fractional_input() {
        assert_eq!(
            clamp_bounds_to_window((10.4, 10.6, 100.4, 100.6), (800.0, 600.0)),
            (10.0, 11.0, 100.0, 101.0)
        );
    }
}
