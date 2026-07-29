package daytona

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// fakeClient is the in-memory Daytona used by unit/contract tests, mirroring
// how the tmux tests fake their runner: commands are recorded verbatim and
// responses are scripted per command substring.
type fakeClient struct {
	mu        sync.Mutex
	nextID    int
	sandboxes map[string]*Sandbox

	execCalls []execCall
	// execHandlers are consulted in order; the first whose substring matches
	// the command answers it. Unmatched commands succeed with empty output.
	execHandlers []execHandler

	gitClones []GitCloneRequest

	createErr error
	listErr   error
	startErr  error
	stopErr   error
	deleteErr error
	gitErr    error

	createdReqs []CreateSandboxRequest
	started     []string
	stopped     []string
	deleted     []string

	// startsAs lets tests make StartSandbox leave the sandbox in a given state
	// (default: started immediately).
	startsAs SandboxState

	// settleAfterGets/settleTo simulate Daytona's async transitions: after N
	// GetSandbox calls, any sandbox in a transitional state settles to
	// settleTo. Zero means states never settle on their own.
	settleAfterGets int
	settleTo        SandboxState
	getCalls        int
}

type execCall struct {
	sandboxID string
	command   string
}

type execHandler struct {
	substr string
	result ExecResult
	err    error
}

func newFakeClient() *fakeClient {
	return &fakeClient{sandboxes: map[string]*Sandbox{}}
}

// seedSandbox registers a sandbox for a session handle in the given state and
// returns its id.
func (f *fakeClient) seedSandbox(handle string, state SandboxState) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := fmt.Sprintf("sb-%d", f.nextID)
	f.sandboxes[id] = &Sandbox{
		ID:     id,
		Name:   "ao-" + handle,
		State:  state,
		Labels: map[string]string{LabelSession: handle},
	}
	return id
}

// onExec scripts a response for commands containing substr.
func (f *fakeClient) onExec(substr string, result ExecResult, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execHandlers = append(f.execHandlers, execHandler{substr: substr, result: result, err: err})
}

func (f *fakeClient) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.execCalls))
	for i, c := range f.execCalls {
		out[i] = c.command
	}
	return out
}

func (f *fakeClient) commandsMatching(substr string) []string {
	var out []string
	for _, c := range f.commands() {
		if strings.Contains(c, substr) {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeClient) CreateSandbox(_ context.Context, req CreateSandboxRequest) (Sandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return Sandbox{}, f.createErr
	}
	f.createdReqs = append(f.createdReqs, req)
	f.nextID++
	id := fmt.Sprintf("sb-%d", f.nextID)
	labels := map[string]string{}
	for k, v := range req.Labels {
		labels[k] = v
	}
	sb := &Sandbox{ID: id, Name: req.Name, State: StateStarted, Labels: labels}
	f.sandboxes[id] = sb
	return *sb, nil
}

func (f *fakeClient) GetSandbox(_ context.Context, id string) (Sandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sb, ok := f.sandboxes[id]
	if !ok {
		return Sandbox{}, fmt.Errorf("%w: %s", ErrSandboxNotFound, id)
	}
	f.getCalls++
	if f.settleAfterGets > 0 && f.getCalls >= f.settleAfterGets && sb.State.Transitional() {
		sb.State = f.settleTo
	}
	return *sb, nil
}

func (f *fakeClient) ListSandboxes(_ context.Context, labels map[string]string) ([]Sandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []Sandbox
	for _, sb := range f.sandboxes {
		match := true
		for k, v := range labels {
			if sb.Labels[k] != v {
				match = false
				break
			}
		}
		if match {
			out = append(out, *sb)
		}
	}
	return out, nil
}

func (f *fakeClient) StartSandbox(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return f.startErr
	}
	f.started = append(f.started, id)
	if sb, ok := f.sandboxes[id]; ok {
		if f.startsAs != "" {
			sb.State = f.startsAs
		} else {
			sb.State = StateStarted
		}
	}
	return nil
}

func (f *fakeClient) StopSandbox(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopErr != nil {
		return f.stopErr
	}
	f.stopped = append(f.stopped, id)
	if sb, ok := f.sandboxes[id]; ok {
		sb.State = StateStopped
	}
	return nil
}

func (f *fakeClient) DeleteSandbox(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, id)
	delete(f.sandboxes, id)
	return nil
}

func (f *fakeClient) Exec(_ context.Context, sandboxID string, req ExecRequest) (ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sandboxes[sandboxID]; !ok {
		return ExecResult{}, fmt.Errorf("%w: %s", ErrSandboxNotFound, sandboxID)
	}
	f.execCalls = append(f.execCalls, execCall{sandboxID: sandboxID, command: req.Command})
	for _, h := range f.execHandlers {
		if strings.Contains(req.Command, h.substr) {
			return h.result, h.err
		}
	}
	return ExecResult{ExitCode: 0}, nil
}

func (f *fakeClient) OpenPTY(context.Context, string, PTYSpec) (PTYConn, error) {
	return nil, fmt.Errorf("fake: pty not scripted")
}

func (f *fakeClient) GitClone(_ context.Context, sandboxID string, req GitCloneRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gitErr != nil {
		return f.gitErr
	}
	if _, ok := f.sandboxes[sandboxID]; !ok {
		return fmt.Errorf("%w: %s", ErrSandboxNotFound, sandboxID)
	}
	f.gitClones = append(f.gitClones, req)
	return nil
}

var _ Client = (*fakeClient)(nil)
