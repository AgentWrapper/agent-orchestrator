package ports

import "context"

// SCMReviewPublisher publishes one AO review through a provider connection.
type SCMReviewPublisher interface {
	PublishReview(ctx context.Context, ref SCMPRRef, publication ReviewPublication) (ReviewPublicationResult, error)
}

// ReviewPublication is one provider-neutral review summary and its inline findings.
type ReviewPublication struct {
	IdempotencyKey string
	TargetSHA      string
	Verdict        string
	Body           string
	Findings       []ReviewFinding
}

// ReviewFinding is one line-specific review comment.
type ReviewFinding struct {
	Path string
	Line int
	Body string
}

// ReviewPublicationResult identifies the provider object created for the review.
type ReviewPublicationResult struct {
	Reference string
}
