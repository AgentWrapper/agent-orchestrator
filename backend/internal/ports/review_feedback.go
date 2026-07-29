package ports

import "context"

// ReviewFeedbackActions performs backend-owned side effects for addressed
// review feedback. Implementations may back these operations with SCM provider
// APIs, AO-internal review threads, or another feedback system.
type ReviewFeedbackActions interface {
	ReplyToReviewThread(ctx context.Context, threadID, body string) error
	ResolveReviewThread(ctx context.Context, threadID string) error
}
