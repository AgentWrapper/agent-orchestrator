package review

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// GitHubReviewPublisher posts a completed Greptile review as one GitHub review
// so each finding can appear as an inline comment on the changed lines.
type GitHubReviewPublisher interface {
	Publish(ctx context.Context, prURL, commitSHA, body string, comments []ports.ReviewComment) (string, error)
}

type githubReviewPublisher struct {
	execute func(context.Context, []string, []byte) ([]byte, error)
}

// NewGitHubReviewPublisher builds the production gh-backed publisher. A
// missing gh binary or authentication is reported per review, not at daemon
// startup, so AO can still record the review result locally.
func NewGitHubReviewPublisher() GitHubReviewPublisher {
	return &githubReviewPublisher{execute: executeGitHubReview}
}

type githubReviewPayload struct {
	CommitID string                `json:"commit_id,omitempty"`
	Body     string                `json:"body"`
	Event    string                `json:"event"`
	Comments []githubInlineComment `json:"comments,omitempty"`
}

type githubInlineComment struct {
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line,omitempty"`
	StartSide string `json:"start_side,omitempty"`
	Body      string `json:"body"`
}

func (p *githubReviewPublisher) Publish(ctx context.Context, prURL, commitSHA, body string, comments []ports.ReviewComment) (string, error) {
	owner, repo, number, err := githubPRRef(prURL)
	if err != nil {
		return "", err
	}
	payload := githubReviewPayload{
		CommitID: strings.TrimSpace(commitSHA),
		Body:     strings.TrimSpace(body),
		Event:    "COMMENT",
		Comments: inlineComments(comments),
	}
	if payload.Body == "" {
		payload.Body = "Greptile reported findings on this pull request."
	}
	if len(payload.Comments) == 0 && payload.Body == "" {
		return "", fmt.Errorf("github review has no body or inline comments")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode GitHub review: %w", err)
	}
	endpoint := "repos/" + owner + "/" + repo + "/pulls/" + strconv.Itoa(number) + "/reviews"
	response, err := p.execute(ctx, []string{"gh", "api", "--method", "POST", "--input", "-", endpoint}, raw)
	if err != nil {
		return "", err
	}
	var decoded struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil {
		return "", fmt.Errorf("decode GitHub review response: %w", err)
	}
	id := strings.Trim(strings.TrimSpace(string(decoded.ID)), "\"")
	if id == "" || id == "null" {
		return "", fmt.Errorf("GitHub review response did not include an id")
	}
	return id, nil
}

func githubPRRef(raw string) (owner, repo string, number int, err error) {
	u, parseErr := url.Parse(strings.TrimSpace(raw))
	if parseErr != nil || u.Hostname() != "github.com" {
		return "", "", 0, fmt.Errorf("GitHub inline review requires a github.com pull request URL")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return "", "", 0, fmt.Errorf("invalid GitHub pull request URL %q", raw)
	}
	n, parseErr := strconv.Atoi(parts[3])
	if parseErr != nil || n <= 0 || parts[0] == "" || parts[1] == "" {
		return "", "", 0, fmt.Errorf("invalid GitHub pull request URL %q", raw)
	}
	return parts[0], parts[1], n, nil
}

func inlineComments(comments []ports.ReviewComment) []githubInlineComment {
	out := make([]githubInlineComment, 0, len(comments))
	for _, comment := range comments {
		path := strings.ReplaceAll(strings.TrimSpace(comment.Path), "\\", "/")
		body := strings.TrimSpace(comment.Body)
		line := comment.EndLine
		if line <= 0 {
			line = comment.StartLine
		}
		if path == "" || line <= 0 || body == "" {
			continue
		}
		side := strings.ToUpper(strings.TrimSpace(comment.Side))
		if side != "LEFT" && side != "RIGHT" {
			side = "RIGHT"
		}
		if suggestion := strings.TrimSpace(comment.Suggestion); suggestion != "" {
			body += "\n\nSuggested fix:\n" + suggestion
		}
		item := githubInlineComment{Path: path, Line: line, Side: side, Body: body}
		if comment.StartLine > 0 && comment.StartLine < line {
			item.StartLine = comment.StartLine
			item.StartSide = side
		}
		out = append(out, item)
	}
	return out
}

func executeGitHubReview(ctx context.Context, argv []string, input []byte) ([]byte, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("GitHub review command is empty")
	}
	cmd := aoprocess.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return nil, fmt.Errorf("post GitHub inline review: %w: %s", err, detail)
		}
		return nil, fmt.Errorf("post GitHub inline review: %w", err)
	}
	return stdout.Bytes(), nil
}
