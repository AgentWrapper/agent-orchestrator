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

type squashMergeRequest struct {
	MergeMethod string `json:"merge_method"`
	SHA         string `json:"sha"`
}

const resolveReviewThreadMutation = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){
    thread{id isResolved}
  }
}`

const replyReviewThreadMutation = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{id}
  }
}`

// SquashMerge merges one pull request only if its head still matches expectedHeadSHA.
func (p *Provider) SquashMerge(ctx context.Context, ref ports.SCMPRRef, expectedHeadSHA string) error {
	owner, repo, err := p.actionRef(ref)
	if err != nil {
		return err
	}
	if strings.TrimSpace(expectedHeadSHA) == "" {
		return ports.ErrSCMActionPrecondition
	}
	response, err := p.client.doREST(ctx, http.MethodPut, repoPath(owner, repo, "pulls", strconv.Itoa(ref.Number), "merge"), nil, squashMergeRequest{
		MergeMethod: "squash",
		SHA:         expectedHeadSHA,
	})
	if err != nil {
		return githubActionError(err)
	}
	var result struct {
		Merged bool `json:"merged"`
	}
	if len(response.Body) == 0 || !jsonUnmarshal(response.Body, &result) || !result.Merged {
		return ports.ErrSCMActionPrecondition
	}
	return nil
}

// ResolveReviewThread resolves one persisted GitHub review thread.
func (p *Provider) ResolveReviewThread(ctx context.Context, ref ports.SCMPRRef, threadID string) error {
	if _, _, err := p.actionRef(ref); err != nil {
		return err
	}
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return fmt.Errorf("%w: empty review thread", ports.ErrSCMNotFound)
	}
	data, err := p.client.doGraphQL(ctx, resolveReviewThreadMutation, map[string]any{"threadId": threadID})
	if err != nil {
		return githubActionError(err)
	}
	mutation, _ := data["resolveReviewThread"].(map[string]any)
	thread, _ := mutation["thread"].(map[string]any)
	if str(thread["id"]) != threadID || !boolv(thread["isResolved"]) {
		return ports.ErrSCMActionPrecondition
	}
	return nil
}

// ReplyReviewThread replies inside one persisted GitHub review thread.
func (p *Provider) ReplyReviewThread(ctx context.Context, ref ports.SCMPRRef, threadID, body string) error {
	if _, _, err := p.actionRef(ref); err != nil {
		return err
	}
	threadID = strings.TrimSpace(threadID)
	body = strings.TrimSpace(body)
	if threadID == "" {
		return fmt.Errorf("%w: empty review thread", ports.ErrSCMNotFound)
	}
	if body == "" {
		return ports.ErrSCMActionPrecondition
	}
	data, err := p.client.doGraphQL(ctx, replyReviewThreadMutation, map[string]any{
		"threadId": threadID,
		"body":     body,
	})
	if err != nil {
		return githubActionError(err)
	}
	mutation, _ := data["addPullRequestReviewThreadReply"].(map[string]any)
	comment, _ := mutation["comment"].(map[string]any)
	if strings.TrimSpace(str(comment["id"])) == "" {
		return ports.ErrSCMActionPrecondition
	}
	return nil
}

func (p *Provider) actionRef(ref ports.SCMPRRef) (string, string, error) {
	if p == nil || p.client == nil || !p.reviewRepoMatchesConnection(ref.Repo) || ref.Number <= 0 {
		return "", "", fmt.Errorf("%w: pull request does not match connection", ports.ErrSCMNotFound)
	}
	owner, repo, ok := githubReviewRepo(ref.Repo)
	if !ok {
		return "", "", fmt.Errorf("%w: invalid pull request repository", ports.ErrSCMNotFound)
	}
	return owner, repo, nil
}

func githubActionError(err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return fmt.Errorf("%w: pull request action target", ports.ErrSCMNotFound)
	case errors.Is(err, ErrAuthFailed):
		return ports.ErrSCMActionForbidden
	case errors.Is(err, ErrPrecondition):
		return ports.ErrSCMActionPrecondition
	default:
		return err
	}
}

func jsonUnmarshal(body []byte, out any) bool {
	return json.Unmarshal(body, out) == nil
}
