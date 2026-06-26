package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// writeMarker writes a ~/.ao/app-state.json marker pointing at appPath into the
// configured state dir (AO_RUN_FILE's directory).
func writeMarker(t *testing.T, cfg testConfig, appPath string) {
	t.Helper()
	st := appState{SchemaVersion: 1, AppPath: appPath, InstallSource: "npm-bootstrap"}
	data, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(cfg.runFile)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, appStateFileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// makeBundle creates a path that stats as a usable bundle on the host OS:
// a directory on macOS (.app), a regular file on Windows/Linux (exe/AppImage),
// matching isUsableBundle's per-OS rule.
func makeBundle(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if runtime.GOOS == "darwin" {
		if err := os.MkdirAll(p, 0o750); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveApp_MarkerHit(t *testing.T) {
	cfg := setConfigEnv(t)
	bundle := makeBundle(t, appBundleName)
	writeMarker(t, cfg, bundle)
	// No scan locations: a hit must come from the marker.
	t.Cleanup(swapScanLocations(func() []string { return nil }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != bundle {
		t.Fatalf("resolveApp = %q, want marker path %q", got, bundle)
	}
}

func TestResolveApp_MarkerMissThenScanHit(t *testing.T) {
	cfg := setConfigEnv(t)
	// Marker points at a path that does not exist -> must fall through to scan.
	writeMarker(t, cfg, filepath.Join(t.TempDir(), "gone", appBundleName))
	scanBundle := makeBundle(t, appBundleName)
	t.Cleanup(swapScanLocations(func() []string { return []string{scanBundle} }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != scanBundle {
		t.Fatalf("resolveApp = %q, want scan path %q", got, scanBundle)
	}
}

func TestResolveApp_ScanMissReturnsEmpty(t *testing.T) {
	setConfigEnv(t) // no marker written
	t.Cleanup(swapScanLocations(func() []string {
		return []string{filepath.Join(t.TempDir(), "nope", appBundleName)}
	}))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != "" {
		t.Fatalf("resolveApp = %q, want empty", got)
	}
}

func TestAssetArchMapping(t *testing.T) {
	cases := map[string]struct {
		want    string
		wantErr bool
	}{
		"arm64": {want: "arm64"},
		"amd64": {want: "x64"},
		"386":   {wantErr: true},
	}
	for goarch, tc := range cases {
		got, err := assetArch(goarch)
		if tc.wantErr {
			if err == nil {
				t.Errorf("assetArch(%q) = %q, want error", goarch, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("assetArch(%q): unexpected error %v", goarch, err)
		}
		if got != tc.want {
			t.Errorf("assetArch(%q) = %q, want %q", goarch, got, tc.want)
		}
	}
}

func TestAssetName_PerOS(t *testing.T) {
	got, err := assetName()
	if err != nil {
		// On unsupported arch (e.g. arm64 win/linux) an error is expected; the
		// per-OS expectation below only applies on amd64/arm64 darwin.
		if runtime.GOOS == "windows" || runtime.GOOS == "linux" {
			if runtime.GOARCH != "amd64" {
				return // unsupported-arch error is correct
			}
		}
		t.Fatalf("assetName() unexpected error: %v", err)
	}
	switch runtime.GOOS {
	case "darwin":
		if got != "agent-orchestrator-darwin-arm64.zip" && got != "agent-orchestrator-darwin-x64.zip" {
			t.Fatalf("darwin assetName = %q", got)
		}
	case "windows":
		if got != "agent-orchestrator-win32-x64.exe" {
			t.Fatalf("windows assetName = %q, want agent-orchestrator-win32-x64.exe", got)
		}
	case "linux":
		if got != "agent-orchestrator-linux-x64.AppImage" {
			t.Fatalf("linux assetName = %q, want agent-orchestrator-linux-x64.AppImage", got)
		}
	}
}

func TestRequireAMD64(t *testing.T) {
	// Host-independent: requireAMD64 keys off runtime.GOARCH, which is amd64 or
	// arm64 on every CI/dev host. Either branch is a valid assertion.
	got, err := requireAMD64()
	if runtime.GOARCH == "amd64" {
		if err != nil || got != "x64" {
			t.Fatalf("requireAMD64() on amd64 = (%q, %v), want (x64, nil)", got, err)
		}
	} else if err == nil {
		t.Fatalf("requireAMD64() on %s = nil error, want unsupported-arch error", runtime.GOARCH)
	}
}

func TestWindowsInstalledExe(t *testing.T) {
	got := windowsInstalledExe("C:\\Users\\me\\AppData\\Local")
	want := filepath.Join("C:\\Users\\me\\AppData\\Local", "Programs", "Agent Orchestrator", "agent-orchestrator.exe")
	if got != want {
		t.Fatalf("windowsInstalledExe = %q, want %q", got, want)
	}
}

func TestKnownAppLocations_HostOS(t *testing.T) {
	// knownAppLocations must return at least one candidate on every supported OS
	// (given the relevant env). Windows needs LOCALAPPDATA; set it so the test is
	// deterministic regardless of host.
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local")
	}
	switch runtime.GOOS {
	case "darwin", "windows", "linux":
		if len(knownAppLocations()) == 0 {
			t.Fatalf("knownAppLocations() empty on %s", runtime.GOOS)
		}
	}
}

func TestIsUsableBundle_RegularFileVsDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "agent-orchestrator.AppImage")
	if err := os.WriteFile(file, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "Agent Orchestrator.app")
	if err := os.MkdirAll(subdir, 0o750); err != nil {
		t.Fatal(err)
	}
	switch runtime.GOOS {
	case "darwin":
		if !isUsableBundle(subdir) {
			t.Fatal("darwin: dir bundle should be usable")
		}
		if isUsableBundle(file) {
			t.Fatal("darwin: regular file should not be a usable bundle")
		}
	case "windows", "linux":
		if !isUsableBundle(file) {
			t.Fatal("win/linux: regular file should be usable")
		}
		if isUsableBundle(subdir) {
			t.Fatal("win/linux: directory should not be a usable bundle")
		}
	}
	if isUsableBundle(filepath.Join(dir, "missing")) {
		t.Fatal("missing path should not be usable")
	}
}

func TestDownloadURLUsesReleaseRepo(t *testing.T) {
	orig := releaseRepo
	releaseRepo = "owner/repo"
	t.Cleanup(func() { releaseRepo = orig })

	got := downloadURL("agent-orchestrator-darwin-arm64.zip")
	want := "https://github.com/owner/repo/releases/latest/download/agent-orchestrator-darwin-arm64.zip"
	if got != want {
		t.Fatalf("downloadURL = %q, want %q", got, want)
	}
}

func TestOpenApp_ArgConstruction(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("openApp launches via `open` only on darwin")
	}
	var gotName string
	var gotArgs []string
	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, name string, args ...string) ([]byte, error) {
			gotName = name
			gotArgs = args
			return nil, nil
		},
	}.withDefaults()}

	opened, err := c.openApp(context.Background(), "/Applications/Agent Orchestrator.app")
	if err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("openApp reported not opened")
	}
	if gotName != "open" {
		t.Fatalf("command = %q, want open", gotName)
	}
	wantArgs := []string{"/Applications/Agent Orchestrator.app", "--args", "--installed-via=npm-bootstrap"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("args = %v, want %v", gotArgs, wantArgs)
	}
}

func TestOpenApp_DetachedSpawnOnWinLinux(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("openApp spawns detached only on windows/linux")
	}
	var gotCfg processStartConfig
	c := &commandContext{deps: Deps{
		StartProcess: func(cfg processStartConfig) error {
			gotCfg = cfg
			return nil
		},
	}.withDefaults()}

	appPath := "/some/agent-orchestrator.AppImage"
	opened, err := c.openApp(context.Background(), appPath)
	if err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("openApp reported not opened")
	}
	if gotCfg.Path != appPath {
		t.Fatalf("spawn path = %q, want %q", gotCfg.Path, appPath)
	}
	wantArgs := []string{"--installed-via=npm-bootstrap"}
	if !reflect.DeepEqual(gotCfg.Args, wantArgs) {
		t.Fatalf("spawn args = %v, want %v", gotCfg.Args, wantArgs)
	}
}

func TestOpenApp_SpawnFailureFallsBackToManual(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("detached-spawn fallback only on windows/linux")
	}
	c := &commandContext{deps: Deps{
		StartProcess: func(processStartConfig) error { return os.ErrNotExist },
	}.withDefaults()}

	opened, err := c.openApp(context.Background(), "/some/app")
	if err != nil {
		t.Fatalf("openApp should swallow spawn errors, got %v", err)
	}
	if opened {
		t.Fatal("openApp should report not-opened on spawn failure")
	}
}

// TestDownload_IgnoresShortClientTimeout proves download() does not inherit the
// 2s deps.HTTPClient timeout (sized for loopback probes), which would otherwise
// fail every real release download. The server responds after a delay that
// exceeds the injected client's tiny timeout; download must still succeed.
func TestDownload_IgnoresShortClientTimeout(t *testing.T) {
	const body = "release-zip-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	c := &commandContext{deps: Deps{
		// 50ms timeout: if download honored this, the 150ms server would fail it.
		HTTPClient: &http.Client{Timeout: 50 * time.Millisecond},
	}.withDefaults()}

	dst := filepath.Join(t.TempDir(), "out.zip")
	if err := c.download(context.Background(), srv.URL, dst); err != nil {
		t.Fatalf("download failed (short client timeout leaked into large-asset path?): %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("downloaded %q, want %q", got, body)
	}
}

// swapScanLocations replaces the scan-location seam and returns a restore func.
func swapScanLocations(fn func() []string) func() {
	orig := appScanLocations
	appScanLocations = fn
	return func() { appScanLocations = orig }
}
