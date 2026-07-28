package cloud

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeDaytona records the last request and serves canned JSON, so the client's
// path/method/header/body construction is asserted without a real Daytona.
type capture struct {
	method, path, query, auth, contentType string
	body                                   []byte
}

func newFakeDaytona(t *testing.T, handler func(*capture) (int, string)) (*DaytonaClient, *capture) {
	t.Helper()
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.query = r.URL.RawQuery
		cap.auth = r.Header.Get("Authorization")
		cap.contentType = r.Header.Get("Content-Type")
		cap.body, _ = io.ReadAll(r.Body)
		status, resp := handler(cap)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, resp)
	}))
	t.Cleanup(srv.Close)
	return NewDaytonaClient("secret-key", srv.URL), cap
}

func TestDaytonaCreateSendsSnapshotAndBearer(t *testing.T) {
	client, cap := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 200, `{"id":"sb-123","state":"started"}`
	})
	box, err := client.Create(context.Background(), CreateSandboxRequest{Snapshot: "daytona-small"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if box.ID != "sb-123" || !box.Running() {
		t.Fatalf("unexpected sandbox %+v", box)
	}
	if cap.method != http.MethodPost || cap.path != "/sandbox" {
		t.Fatalf("want POST /sandbox, got %s %s", cap.method, cap.path)
	}
	if cap.auth != "Bearer secret-key" {
		t.Fatalf("missing/wrong bearer: %q", cap.auth)
	}
	if !strings.Contains(string(cap.body), `"snapshot":"daytona-small"`) {
		t.Fatalf("snapshot not in body: %s", cap.body)
	}
}

func TestDaytonaExecHitsToolboxProcessExecute(t *testing.T) {
	client, cap := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 200, `{"exitCode":0,"result":"hello"}`
	})
	box := Sandbox{ID: "sb-1", ToolboxProxyURL: strings.TrimSuffix(client.baseURL, "") + "/toolbox"}
	res, err := client.Exec(context.Background(), box, ExecuteRequest{Command: "echo hi", Cwd: "/tmp", Timeout: 30})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.ExitCode != 0 || res.Result != "hello" {
		t.Fatalf("unexpected exec result %+v", res)
	}
	// Toolbox calls go to {toolboxProxyUrl}/{id}/process/execute.
	if cap.path != "/toolbox/sb-1/process/execute" {
		t.Fatalf("wrong exec path: %s", cap.path)
	}
	if !strings.Contains(string(cap.body), `"command":"echo hi"`) {
		t.Fatalf("command not in body: %s", cap.body)
	}
}

func TestDaytonaUploadFileIsMultipartWithPathQuery(t *testing.T) {
	client, cap := newFakeDaytona(t, func(_ *capture) (int, string) { return 200, `{}` })
	box := Sandbox{ID: "sb-1", ToolboxProxyURL: client.baseURL + "/toolbox"}
	if err := client.UploadFile(context.Background(), box, "/home/daytona/ao", []byte("BINARY")); err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if cap.path != "/toolbox/sb-1/files/upload" {
		t.Fatalf("wrong upload path: %s", cap.path)
	}
	if !strings.Contains(cap.query, "path=") || !strings.Contains(cap.query, "%2Fhome%2Fdaytona%2Fao") {
		t.Fatalf("destination path not in query: %s", cap.query)
	}
	mt, _, _ := mime.ParseMediaType(cap.contentType)
	if mt != "multipart/form-data" {
		t.Fatalf("want multipart/form-data, got %q", cap.contentType)
	}
	if !strings.Contains(string(cap.body), "BINARY") {
		t.Fatalf("file bytes not in multipart body")
	}
}

func TestDaytonaSignedPreviewUsesExpiresInSeconds(t *testing.T) {
	client, cap := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 200, `{"sandboxId":"sb-1","port":3001,"token":"tok","url":"https://3001-sb.daytona.example/?t=tok"}`
	})
	signed, err := client.SignedPreview(context.Background(), "sb-1", 3001, 1800)
	if err != nil {
		t.Fatalf("SignedPreview: %v", err)
	}
	if signed.URL == "" || signed.Token != "tok" {
		t.Fatalf("unexpected signed preview %+v", signed)
	}
	if cap.path != "/sandbox/sb-1/ports/3001/signed-preview-url" {
		t.Fatalf("wrong signed-preview path: %s", cap.path)
	}
	if !strings.Contains(cap.query, "expiresInSeconds=1800") {
		t.Fatalf("ttl not in query: %s", cap.query)
	}
}

func TestDaytonaListAcceptsArrayOrItemsEnvelope(t *testing.T) {
	// bare array
	c1, _ := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 200, `[{"id":"a","state":"started"},{"id":"b","state":"stopped"}]`
	})
	arr, err := c1.List(context.Background())
	if err != nil || len(arr) != 2 {
		t.Fatalf("array list: %v %+v", err, arr)
	}
	// {items:[...]} envelope
	c2, _ := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 200, `{"items":[{"id":"c","state":"started"}]}`
	})
	env, err := c2.List(context.Background())
	if err != nil || len(env) != 1 || env[0].ID != "c" {
		t.Fatalf("items list: %v %+v", err, env)
	}
}

func TestDaytonaErrorRedactsQueryString(t *testing.T) {
	client, _ := newFakeDaytona(t, func(_ *capture) (int, string) {
		return 500, `{"message":"boom"}`
	})
	_, err := client.SignedPreview(context.Background(), "sb-1", 3001, 1800)
	if err == nil {
		t.Fatal("want error on 500")
	}
	// The signed-url token lives in the query string, which must not leak into logs.
	if strings.Contains(err.Error(), "expiresInSeconds") {
		t.Fatalf("error leaked query string: %v", err)
	}
}

func TestNormalizeGitURL(t *testing.T) {
	cases := map[string]string{
		"git@github.com:Pritom14/carbon-layer.git":       "https://github.com/Pritom14/carbon-layer.git",
		"ssh://git@github.com/Pritom14/carbon-layer.git": "https://github.com/Pritom14/carbon-layer.git",
		"https://github.com/Pritom14/carbon-layer.git":   "https://github.com/Pritom14/carbon-layer.git",
		"":                                  "",
		"  git@github.com:owner/repo.git  ": "https://github.com/owner/repo.git",
	}
	for in, want := range cases {
		if got := normalizeGitURL(in); got != want {
			t.Errorf("normalizeGitURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSharePayloadRoundTrips(t *testing.T) {
	// The token is base64url(JSON); a viewer decodes it the same way.
	payload := SharePayload{V: 1, PreviewURL: "https://x.daytona/", SandboxID: "sb", SessionID: "s-1", Harness: "claude-code", Mode: "readonly"}
	buf, _ := json.Marshal(payload)
	var back SharePayload
	if err := json.Unmarshal(buf, &back); err != nil || back.SandboxID != "sb" || back.Mode != "readonly" {
		t.Fatalf("round-trip failed: %v %+v", err, back)
	}
}
