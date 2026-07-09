package ports

import "context"

// SCMPRActions performs irreversible pull-request mutations through an SCM
// provider. Implementations must not retry these calls automatically.
type SCMPRActions interface {
	MergePR(ctx context.Context, owner, repo string, number int, method string) error
	ClosePR(ctx context.Context, owner, repo string, number int) error
}
