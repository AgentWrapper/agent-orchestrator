# Remote Directory Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Remote desktop client create one direct child directory on the daemon host, automatically enter it, and select it through the existing project flow.

**Architecture:** Add `POST /api/v1/filesystem/directories` beside the existing GET route. The controller validates an absolute parent plus one safe child name and calls `os.Mkdir`; the existing authenticated Electron forwarding proxy transports the request unchanged. The Remote picker owns a small inline form and reloads the returned server path after success.

**Tech Stack:** Go 1.25, chi, generated OpenAPI, React 19, TypeScript, openapi-fetch, Vitest, Testing Library

## Global Constraints

- Keep the primary listener on `127.0.0.1` and the authenticated LAN listener on `0.0.0.0:3011`.
- Access is limited only by daemon-user OS permissions; add no allowlist or privilege escalation.
- Create one child with `os.Mkdir`; never use `MkdirAll`.
- Never return raw OS errors or sensitive paths.
- Do not change project, session, SSE, WebSocket, terminal, SQLite, or Electron-forwarder contracts.
- Keep `/Applications/Agent Orchestrator.app` untouched; update only the Remote application.

---

### Task 1: Create-Directory HTTP Contract

**Files:**
- Modify: `backend/internal/httpd/controllers/filesystem_test.go`
- Modify: `backend/internal/httpd/controllers/filesystem_internal_test.go`
- Modify: `backend/internal/httpd/controllers/filesystem.go`
- Modify: `backend/internal/httpd/controllers/dto.go`

**Interfaces:**
- Consumes: the existing app API router and `decodeJSONStrict`.
- Produces: `POST /api/v1/filesystem/directories` accepting `CreateDirectoryRequest` and returning `201 DirectoryEntry`.

- [ ] **Step 1: Add failing public API tests**

Add a helper and a real-filesystem success test:

```go
func createDirectoryBody(parentPath, name string) string {
	body, _ := json.Marshal(map[string]string{"parentPath": parentPath, "name": name})
	return string(body)
}

func TestFilesystemAPI_CreateDirectory(t *testing.T) {
	srv := newFilesystemTestServer(t)
	parent := t.TempDir()
	body, status, headers := doRequest(t, srv, http.MethodPost,
		"/api/v1/filesystem/directories", createDirectoryBody(parent, "new-project"))
	assertJSON(t, headers)
	if status != http.StatusCreated {
		t.Fatalf("POST directory = %d, want 201; body=%s", status, body)
	}
	var got struct{ Name, Path string }
	mustJSON(t, body, &got)
	want := filepath.Join(parent, "new-project")
	if got.Name != "new-project" || got.Path != want {
		t.Fatalf("response = %#v, want path %q", got, want)
	}
	info, err := os.Stat(want)
	if err != nil || !info.IsDir() {
		t.Fatalf("created directory stat = (%v, %v)", info, err)
	}
}
```

Add table cases for `.hidden` success; invalid/unknown/trailing JSON; relative or blank parent; blank, whitespace, `.`, `..`, slash, backslash, and NUL names; existing file/directory; missing parent; and a file parent. Assert stable codes `INVALID_JSON`, `ABSOLUTE_PATH_REQUIRED`, `INVALID_DIRECTORY_NAME`, `DIRECTORY_ALREADY_EXISTS`, `DIRECTORY_NOT_FOUND`, and `NOT_A_DIRECTORY`.

- [ ] **Step 2: Add failing internal create-error mapper tests**

```go
tests := []struct {
	name       string
	err        error
	wantStatus int
	wantCode   string
}{
	{name: "exists", err: fs.ErrExist, wantStatus: http.StatusConflict, wantCode: "DIRECTORY_ALREADY_EXISTS"},
	{name: "permission", err: fs.ErrPermission, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
	{name: "read only", err: syscall.EROFS, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
	{name: "missing", err: fs.ErrNotExist, wantStatus: http.StatusNotFound, wantCode: "DIRECTORY_NOT_FOUND"},
	{name: "not directory", err: syscall.ENOTDIR, wantStatus: http.StatusUnprocessableEntity, wantCode: "NOT_A_DIRECTORY"},
	{name: "unexpected", err: errors.New("boom"), wantStatus: http.StatusInternalServerError, wantCode: "DIRECTORY_CREATE_FAILED"},
}
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd backend
go test ./internal/httpd/controllers -run 'TestFilesystem(API_CreateDirectory|CreateErrorMapper)' -count=1
```

Expected: FAIL because POST is not registered and the create mapper is absent.

- [ ] **Step 4: Add the DTO and minimal handler**

```go
type CreateDirectoryRequest struct {
	ParentPath string `json:"parentPath"`
	Name       string `json:"name"`
}

func (c *FilesystemController) createDirectory(w http.ResponseWriter, r *http.Request) {
	var in CreateDirectoryRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !filepath.IsAbs(in.ParentPath) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ABSOLUTE_PATH_REQUIRED", "Parent path must be absolute", nil)
		return
	}
	if !validDirectoryName(in.Name) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_DIRECTORY_NAME", "Directory name is invalid", nil)
		return
	}
	parent := filepath.Clean(in.ParentPath)
	target := filepath.Join(parent, in.Name)
	if err := os.Mkdir(target, 0o755); err != nil {
		writeDirectoryCreateError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, DirectoryEntry{Name: in.Name, Path: target})
}

func validDirectoryName(name string) bool {
	return name != "" && strings.TrimSpace(name) == name && name != "." && name != ".." &&
		!strings.ContainsRune(name, 0) && !strings.ContainsAny(name, `/\\`)
}
```

Register `r.Post("/filesystem/directories", c.createDirectory)`. Implement `writeDirectoryCreateError` with the exact Step 2 mapping and no error details.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
cd backend
go test ./internal/httpd/controllers -run 'TestFilesystem(API_CreateDirectory|CreateErrorMapper)' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit the HTTP behavior**

```bash
git add backend/internal/httpd/controllers/filesystem.go backend/internal/httpd/controllers/filesystem_test.go backend/internal/httpd/controllers/filesystem_internal_test.go backend/internal/httpd/controllers/dto.go
git commit -m "feat: create remote project directories"
```

### Task 2: Generated OpenAPI Contract

**Files:**
- Modify: `backend/internal/httpd/apispec/specgen/build.go`
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`
- Regenerate: `frontend/src/api/schema.ts`

**Interfaces:**
- Consumes: Task 1 DTOs.
- Produces: typed `apiClient.POST("/api/v1/filesystem/directories", ...)` support.

- [ ] **Step 1: Register the schema and operation**

Map `ControllersCreateDirectoryRequest` to `CreateDirectoryRequest`, change the filesystem tag description to include creation, and append:

```go
{
	method: http.MethodPost, path: "/api/v1/filesystem/directories", id: "createDirectory", tag: "filesystem",
	summary: "Create one child directory using daemon-user permissions",
	reqBody: controllers.CreateDirectoryRequest{},
	resps: []respUnit{
		{http.StatusCreated, controllers.DirectoryEntry{}},
		{http.StatusBadRequest, envelope.APIError{}},
		{http.StatusForbidden, envelope.APIError{}},
		{http.StatusNotFound, envelope.APIError{}},
		{http.StatusConflict, envelope.APIError{}},
		{http.StatusUnprocessableEntity, envelope.APIError{}},
		{http.StatusInternalServerError, envelope.APIError{}},
	},
},
```

- [ ] **Step 2: Regenerate and verify parity**

```bash
npm run api
cd backend
go test ./internal/httpd/... -count=1
```

Expected: generated YAML and TypeScript include `createDirectory`; all HTTP/spec tests PASS.

- [ ] **Step 3: Commit generated files together**

```bash
git add backend/internal/httpd/apispec/specgen/build.go backend/internal/httpd/apispec/openapi.yaml frontend/src/api/schema.ts
git commit -m "feat: publish remote directory creation API"
```

### Task 3: Remote Picker Interaction

**Files:**
- Modify: `frontend/src/renderer/components/RemoteDirectoryPickerDialog.test.tsx`
- Modify: `frontend/src/renderer/components/RemoteDirectoryPickerDialog.tsx`

**Interfaces:**
- Consumes: generated POST operation.
- Produces: New folder form that enters the created directory.

- [ ] **Step 1: Add failing interaction tests**

```ts
const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (error: unknown, fallback = "Request failed") =>
		typeof error === "object" && error !== null && "message" in error ? String(error.message) : fallback,
}));
```

Test that New folder opens `Folder name`, blank disables Create, submitting calls:

```ts
expect(postMock).toHaveBeenCalledWith("/api/v1/filesystem/directories", {
	body: { parentPath: "/home/ubuntu/code", name: "new-project" },
});
```

Then assert a `201` result triggers GET of the returned path and Select returns it. Test API-error draft retention, duplicate-submit prevention, busy navigation disabling, and cancel reset.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd frontend
npm test -- --run src/renderer/components/RemoteDirectoryPickerDialog.test.tsx
```

Expected: FAIL because no New folder control exists.

- [ ] **Step 3: Implement minimal create behavior**

Add `Check` and `FolderPlus`, draft/open/creating state, an inline labeled form, and:

```ts
const createFolder = async (event: FormEvent<HTMLFormElement>) => {
	event.preventDefault();
	const name = newFolderName.trim();
	if (!current || !name || creatingFolder) return;
	setCreatingFolder(true);
	setError(null);
	try {
		const { data, error: apiError } = await apiClient.POST("/api/v1/filesystem/directories", {
			body: { parentPath: current.path, name },
		});
		if (apiError) return setError(apiErrorMessage(apiError, "Could not create folder"));
		if (data) {
			setNewFolderName("");
			setNewFolderOpen(false);
			await openPath(data.path);
		}
	} catch (cause) {
		setError(apiErrorMessage(cause, "Could not create folder"));
	} finally {
		setCreatingFolder(false);
	}
};
```

Treat `loading || creatingFolder` as busy. Reset the form on dialog close. Do not synthesize a local listing.

- [ ] **Step 4: Verify GREEN and typecheck**

```bash
cd frontend
npm test -- --run src/renderer/components/RemoteDirectoryPickerDialog.test.tsx
cd ..
npm run frontend:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the UI**

```bash
git add frontend/src/renderer/components/RemoteDirectoryPickerDialog.tsx frontend/src/renderer/components/RemoteDirectoryPickerDialog.test.tsx
git commit -m "feat: create folders in remote browser"
```

### Task 4: Documentation and Deployment Hand-off

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-remote-client-headless-daemon-design.md`

**Interfaces:**
- Consumes: completed API and UI behavior.
- Produces: accurate docs and a daemon ready for the integrated client deployment.

- [ ] **Step 1: Correct the old read-only design text**

Document GET plus POST, `{parentPath,name}`, direct-child-only behavior, daemon-user permissions, authenticated LAN exposure, `201 DirectoryEntry`, and all create error codes.

- [ ] **Step 2: Run backend/frontend regression checks**

```bash
npm run lint
cd frontend
npm test
cd ..
npm run frontend:typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Deploy only to `ubuntu@192.168.2.220`**

Inspect the active unit for its real binary path, build Linux amd64 from the exact commit, upload to a temporary sibling, atomically replace the binary, and restart `ao-daemon.service`. Preserve its environment, `~/.ao`, password, and unit definition.

- [ ] **Step 4: Run authenticated smoke verification**

Verify enabled+active service, loopback health, unauthenticated LAN `401`, authenticated create/browse, duplicate `409`, OS existence as `ubuntu`, and removal of only the unique empty smoke directory. Never print the password.

- [ ] **Step 5: Defer packaging to the integrated client task**

Task 9 of the internationalization plan builds and installs one final Remote app containing both features, then verifies New folder, auto-enter, Select, and that Finder never opens.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/superpowers/specs/2026-07-15-remote-client-headless-daemon-design.md
git commit -m "docs: describe remote directory creation"
```
