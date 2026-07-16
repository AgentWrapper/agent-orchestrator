package ports

import "time"

// SCMRateLimitError is the optional structured backoff contract implemented by
// provider rate-limit errors.
type SCMRateLimitError interface {
	error
	RateLimitDelay(now time.Time) time.Duration
}
