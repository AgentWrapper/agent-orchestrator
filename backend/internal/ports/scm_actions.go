package ports

import "context"

// SCMReviewActions performs provider-owned review-thread mutations. Agents and
// reviewer agents report intent to AO; daemon services call this port for the
// SCM side effects.
type SCMReviewActions interface {
	ReplyToReviewThread(ctx context.Context, threadID, body string) error
	ResolveReviewThread(ctx context.Context, threadID string) error
}
