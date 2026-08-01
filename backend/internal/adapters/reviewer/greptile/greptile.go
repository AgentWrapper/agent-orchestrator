// Package greptile adapts the Greptile CLI's one-shot JSON review mode to AO's
// reviewer contract.
package greptile

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Adapter runs Greptile once per pull request. Unlike AO's interactive
// reviewers, it does not accept follow-up messages; the terminal runner only
// displays its progress and findings.
type Adapter struct{}

var _ ports.OneShotReviewer = Adapter{}
var _ ports.TerminalOneShotReviewer = Adapter{}
var _ ports.ReviewerCanceller = Adapter{}

func New() Adapter { return Adapter{} }

func (Adapter) Harness() domain.ReviewerHarness { return domain.ReviewerGreptile }

func (Adapter) ReviewCommand(_ context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	argv := []string{"greptile", "review", "--json"}
	if branch := targetBranch(inv); branch != "" {
		argv = append(argv, "--branch", branch)
	}
	return ports.ReviewCommandSpec{Argv: argv}, nil
}

func (Adapter) ReviewMessage(context.Context, ports.ReviewInvocation) (string, error) {
	return "", errors.New("greptile is a one-shot reviewer and does not accept review messages")
}

// ReviewCancel lets AO interrupt the display-only terminal after a daemon
// restart, when the in-memory one-shot job map is no longer available.
func (Adapter) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}

type cliReview struct {
	Summary             *string      `json:"summary"`
	Confidence          *int         `json:"confidence"`
	ConfidenceReasoning *string      `json:"confidenceReasoning"`
	SecuritySummary     *string      `json:"securitySummary"`
	Comments            []cliComment `json:"comments"`
}

type cliComment struct {
	Path          string  `json:"path"`
	StartLine     int     `json:"startLine"`
	EndLine       int     `json:"endLine"`
	Side          string  `json:"side"`
	Severity      string  `json:"severity"`
	SecurityIssue bool    `json:"securityIssue"`
	Body          string  `json:"body"`
	Suggestion    *string `json:"suggestion"`
}

func (Adapter) ParseReviewResult(output []byte) (ports.ReviewResult, error) {
	var review cliReview
	decoder := json.NewDecoder(bytes.NewReader(output))
	if err := decoder.Decode(&review); err != nil {
		return ports.ReviewResult{}, fmt.Errorf("decode greptile review JSON: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return ports.ReviewResult{}, err
	}

	verdict := domain.VerdictApproved
	if len(review.Comments) > 0 {
		verdict = domain.VerdictChangesRequested
	}
	return ports.ReviewResult{
		Verdict:  verdict,
		Body:     formatReview(review),
		Comments: normalizeComments(review.Comments),
	}, nil
}

func targetBranch(inv ports.ReviewInvocation) string {
	if inv.ReviewIndex >= 0 && inv.ReviewIndex < len(inv.ReviewQueue) {
		return strings.TrimSpace(inv.ReviewQueue[inv.ReviewIndex].TargetBranch)
	}
	return ""
}

func normalizeComments(comments []cliComment) []ports.ReviewComment {
	out := make([]ports.ReviewComment, 0, len(comments))
	for _, comment := range comments {
		out = append(out, ports.ReviewComment{
			Path:          strings.TrimSpace(comment.Path),
			StartLine:     comment.StartLine,
			EndLine:       comment.EndLine,
			Side:          commentSide(comment.Side),
			Body:          strings.TrimSpace(comment.Body),
			Suggestion:    nonEmpty(comment.Suggestion),
			Severity:      strings.TrimSpace(comment.Severity),
			SecurityIssue: comment.SecurityIssue,
		})
	}
	return out
}

func commentSide(side string) string {
	switch strings.ToUpper(strings.TrimSpace(side)) {
	case "LEFT":
		return "LEFT"
	default:
		return "RIGHT"
	}
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	switch {
	case errors.Is(err, io.EOF):
		return nil
	case err != nil:
		return fmt.Errorf("decode trailing greptile review JSON: %w", err)
	default:
		return errors.New("greptile review output contains multiple JSON values")
	}
}

func formatReview(review cliReview) string {
	var body strings.Builder
	body.WriteString("## Greptile review\n")
	if summary := nonEmpty(review.Summary); summary != "" {
		body.WriteString("\n")
		body.WriteString(summary)
		body.WriteString("\n")
	}
	if review.Confidence != nil {
		body.WriteString("\n**Confidence:** ")
		body.WriteString(strconv.Itoa(*review.Confidence))
		body.WriteString("/5")
		if reasoning := nonEmpty(review.ConfidenceReasoning); reasoning != "" {
			body.WriteString(" — ")
			body.WriteString(reasoning)
		}
		body.WriteString("\n")
	}
	if security := nonEmpty(review.SecuritySummary); security != "" {
		body.WriteString("\n**Security:** ")
		body.WriteString(security)
		body.WriteString("\n")
	}

	if len(review.Comments) == 0 {
		body.WriteString("\nNo actionable findings.\n")
		return strings.TrimSpace(body.String())
	}

	body.WriteString("\n### Findings\n")
	for i, comment := range review.Comments {
		body.WriteString("\n#### ")
		severity := strings.TrimSpace(comment.Severity)
		if severity == "" {
			severity = "Finding"
		}
		body.WriteString(severity)
		if comment.SecurityIssue {
			body.WriteString(" · Security")
		}
		if location := commentLocation(comment); location != "" {
			body.WriteString(" · `")
			body.WriteString(strings.ReplaceAll(location, "`", "'"))
			body.WriteString("`")
		}
		body.WriteString("\n\n")
		if finding := strings.TrimSpace(comment.Body); finding != "" {
			body.WriteString(finding)
		} else {
			body.WriteString("Greptile reported an actionable finding.")
		}
		body.WriteString("\n")
		if suggestion := nonEmpty(comment.Suggestion); suggestion != "" {
			body.WriteString("\n**Suggested fix:**\n\n")
			for _, line := range strings.Split(suggestion, "\n") {
				body.WriteString("> ")
				body.WriteString(line)
				body.WriteString("\n")
			}
		}
		if i < len(review.Comments)-1 {
			body.WriteString("\n")
		}
	}
	return strings.TrimSpace(body.String())
}

func commentLocation(comment cliComment) string {
	path := strings.TrimSpace(comment.Path)
	if path == "" {
		return ""
	}
	if comment.StartLine <= 0 {
		return path
	}
	location := path + ":" + strconv.Itoa(comment.StartLine)
	if comment.EndLine > comment.StartLine {
		location += "-" + strconv.Itoa(comment.EndLine)
	}
	return location
}

func nonEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
