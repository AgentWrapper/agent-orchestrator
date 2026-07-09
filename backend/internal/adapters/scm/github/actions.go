package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultMergeMethod = "squash"

// MergePR performs PUT /repos/{owner}/{repo}/pulls/{number}/merge with the
// given merge method (defaults to squash). On success it returns the provider
// merge result; failures map to the client sentinels (not found / not mergeable
// / unprocessable / auth / rate limit).
func (p *Provider) MergePR(ctx context.Context, ref ports.SCMPRRef, method string) (ports.PRMergeResult, error) {
	owner, name, number, err := resolveActionRef(ref)
	if err != nil {
		return ports.PRMergeResult{}, err
	}
	if method == "" {
		method = defaultMergeMethod
	}
	body := map[string]any{"merge_method": method}
	path := repoPath(owner, name, "pulls", strconv.Itoa(number), "merge")
	resp, err := p.client.doREST(ctx, http.MethodPut, path, nil, body)
	if err != nil {
		return ports.PRMergeResult{}, mapActionError(err)
	}
	var payload struct {
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	if len(resp.Body) > 0 {
		if err := json.Unmarshal(resp.Body, &payload); err != nil {
			return ports.PRMergeResult{}, fmt.Errorf("github scm: decode merge response: %w", err)
		}
	}
	// GitHub returns 200 with merged:true on success. A body without confirmation
	// is treated as a failed merge so we never report fake success.
	if !payload.Merged && payload.SHA == "" {
		return ports.PRMergeResult{}, fmt.Errorf("%w: merge response did not confirm merge", ErrNotMergeable)
	}
	return ports.PRMergeResult{
		Merged: true,
		SHA:    payload.SHA,
		Method: method,
	}, nil
}

const listUnresolvedThreadsQuery = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(last:100){
        nodes{ id isResolved }
      }
    }
  }
}`

// ListUnresolvedThreadIDs returns GraphQL node IDs for unresolved review threads
// on the PR. Used by resolve-all and as an existence probe when explicit IDs are
// supplied by the caller.
func (p *Provider) ListUnresolvedThreadIDs(ctx context.Context, ref ports.SCMPRRef) ([]string, error) {
	owner, name, number, err := resolveActionRef(ref)
	if err != nil {
		return nil, err
	}
	data, err := p.client.doGraphQL(ctx, listUnresolvedThreadsQuery, map[string]any{
		"owner": owner, "repo": name, "number": number,
	})
	if err != nil {
		return nil, mapActionError(err)
	}
	repoData, _ := data["repository"].(map[string]any)
	if repoData == nil {
		return nil, fmt.Errorf("%w: repository not found", ErrNotFound)
	}
	pr, _ := repoData["pullRequest"].(map[string]any)
	if pr == nil {
		return nil, fmt.Errorf("%w: pull request not found", ErrNotFound)
	}
	threads, _ := pr["reviewThreads"].(map[string]any)
	var out []string
	for _, n := range nodes(threads["nodes"]) {
		if boolv(n["isResolved"]) {
			continue
		}
		id := str(n["id"])
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

const resolveThreadMutation = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ id isResolved }
  }
}`

// ResolveThread marks one review thread resolved via the GraphQL mutation.
func (p *Provider) ResolveThread(ctx context.Context, threadID string) error {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return fmt.Errorf("%w: empty thread id", ErrUnprocessable)
	}
	data, err := p.client.doGraphQL(ctx, resolveThreadMutation, map[string]any{"id": threadID})
	if err != nil {
		return mapActionError(err)
	}
	// GraphQL may return data with a null payload when the thread id is invalid.
	payload, _ := data["resolveReviewThread"].(map[string]any)
	if payload == nil {
		return fmt.Errorf("%w: resolveReviewThread returned no payload", ErrUnprocessable)
	}
	thread, _ := payload["thread"].(map[string]any)
	if thread == nil {
		return fmt.Errorf("%w: resolveReviewThread returned no thread", ErrUnprocessable)
	}
	return nil
}

// Compile-time check that *Provider satisfies ports.PRActioner.
var _ ports.PRActioner = (*Provider)(nil)

func resolveActionRef(ref ports.SCMPRRef) (owner, name string, number int, err error) {
	owner = strings.TrimSpace(ref.Repo.Owner)
	name = strings.TrimSpace(ref.Repo.Name)
	number = ref.Number
	if (owner == "" || name == "") && ref.URL != "" {
		o, r, n, parseErr := parsePRURL(ref.URL)
		if parseErr != nil {
			return "", "", 0, fmt.Errorf("%w: %v", ErrNotFound, parseErr)
		}
		if owner == "" {
			owner = o
		}
		if name == "" {
			name = r
		}
		if number <= 0 {
			number = n
		}
	}
	if owner == "" || name == "" || number <= 0 {
		return "", "", 0, fmt.Errorf("%w: incomplete PR ref", ErrNotFound)
	}
	return owner, name, number, nil
}

func mapActionError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrNotFound):
		return err
	case errors.Is(err, ErrNotMergeable):
		return err
	case errors.Is(err, ErrUnprocessable):
		return err
	case errors.Is(err, ErrAuthFailed):
		return fmt.Errorf("%w: %w", ports.ErrSCMAuthFailed, err)
	case errors.Is(err, ErrRateLimited):
		return err
	case errors.Is(err, ErrNoToken):
		return fmt.Errorf("%w: %w", ports.ErrSCMAuthFailed, err)
	default:
		return err
	}
}