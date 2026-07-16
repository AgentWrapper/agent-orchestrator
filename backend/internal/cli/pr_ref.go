package cli

import (
	"context"
	"errors"
	"strings"
)

func (c *commandContext) resolvePRRef(_ context.Context, ref string, _ projectDetails) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", usageError{errors.New("pull/merge request reference is required")}
	}
	return ref, nil
}
