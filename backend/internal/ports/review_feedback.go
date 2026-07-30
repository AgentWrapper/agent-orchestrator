package ports

import "context"

// ReviewFeedbackActions performs backend-owned side effects for addressed
// review feedback. Agents signal intent to AO; adapters own provider mutation
// calls such as replying to and resolving SCM review threads.
type ReviewFeedbackActions interface {
	ReplyToReviewThread(ctx context.Context, threadID, body string) error
	ResolveReviewThread(ctx context.Context, threadID string) error
}
