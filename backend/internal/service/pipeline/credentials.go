package pipelinesvc

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// The write half of decision D13. Values enter here and leave only into a
// command stage's process env at exec time: there is deliberately no service
// method that returns one, so no HTTP response and no CLI output can carry a
// secret back out. Listing answers with names.

// SetCredential creates or replaces a project's named credential. The
// environment is stored wholesale, so setting a name again is how a variable is
// removed from it.
func (s *Service) SetCredential(ctx context.Context, projectID domain.ProjectID, name string, env map[string]string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return apierr.Invalid("PIPELINE_CREDENTIAL_NAME_REQUIRED", "a credential name is required", nil)
	}
	if len(env) == 0 {
		return apierr.Invalid("PIPELINE_CREDENTIAL_ENV_REQUIRED",
			fmt.Sprintf("credential %q needs at least one KEY=VALUE variable", name), nil)
	}
	for key := range env {
		if err := validEnvKey(key); err != nil {
			return err
		}
	}
	return s.store.SetPipelineCredential(ctx, projectID, name, env, s.now())
}

// ListCredentialNames returns the project's declared credential names, sorted.
func (s *Service) ListCredentialNames(ctx context.Context, projectID domain.ProjectID) ([]string, error) {
	names, err := s.store.ListPipelineCredentialNames(ctx, projectID)
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

// DeleteCredential removes a credential. Deleting one that is not there is a
// not-found error rather than a silent success, so a typo does not read as a
// secret having been revoked.
func (s *Service) DeleteCredential(ctx context.Context, projectID domain.ProjectID, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return apierr.Invalid("PIPELINE_CREDENTIAL_NAME_REQUIRED", "a credential name is required", nil)
	}
	ok, err := s.store.DeletePipelineCredential(ctx, projectID, name)
	if err != nil {
		return err
	}
	if !ok {
		return apierr.NotFound("PIPELINE_CREDENTIAL_NOT_FOUND", fmt.Sprintf("no credential %q in this project", name))
	}
	return nil
}

// validEnvKey rejects anything that cannot be an environment variable name, so
// a mistyped KEY=VALUE fails at set time instead of vanishing into a stage's
// env. The message names the key and never the value.
func validEnvKey(key string) error {
	bad := func() error {
		return apierr.Invalid("PIPELINE_CREDENTIAL_ENV_INVALID",
			fmt.Sprintf("%q is not a valid environment variable name", key), nil)
	}
	if key == "" {
		return bad()
	}
	for i, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return bad()
		}
	}
	return nil
}
