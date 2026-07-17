package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// ExecutionProfileVersion identifies the canonical hash/schema contract.
	ExecutionProfileVersion = "execution-profile/v1"
	// ExecutionProfileAgentDefault explicitly pins use of the harness default.
	ExecutionProfileAgentDefault = "agent-default"
)

// ReviewModelPolicy says whether review reuses the worker model or pins another.
type ReviewModelPolicy string

const (
	// ReviewModelSameModel reuses the configured worker model for review.
	ReviewModelSameModel ReviewModelPolicy = "same-model"
	// ReviewModelExplicit requires the profile's ReviewModel.
	ReviewModelExplicit ReviewModelPolicy = "explicit"
)

var (
	// ErrExecutionProfileMissing means a session has no profile contract.
	ErrExecutionProfileMissing = errors.New("execution profile is missing")
	// ErrExecutionProfileDrift means profile fields do not match their hash.
	ErrExecutionProfileDrift = errors.New("execution profile does not match its hash")
	// ErrExecutionProfileUnauthorized rejects non-human profile mutation.
	ErrExecutionProfileUnauthorized = errors.New("execution profile change requires explicit human authority")
)

// ExecutionProfile is the immutable launch contract attached to a session.
// Hash is a SHA-256 of the canonical profile fields excluding Hash itself.
type ExecutionProfile struct {
	Version              string            `json:"version"`
	Model                string            `json:"model"`
	ReasoningEffort      string            `json:"reasoning_effort"`
	FastMode             bool              `json:"fast_mode"`
	ReviewModel          string            `json:"review_model,omitempty"`
	ReviewModelPolicy    ReviewModelPolicy `json:"review_model_policy"`
	AllowNativeSubagents bool              `json:"allow_native_subagents"`
	AuthoritySource      string            `json:"authority_source"`
	Hash                 string            `json:"hash"`
}

type executionProfileCanonical struct {
	Version              string            `json:"version"`
	Model                string            `json:"model"`
	ReasoningEffort      string            `json:"reasoning_effort"`
	FastMode             bool              `json:"fast_mode"`
	ReviewModel          string            `json:"review_model,omitempty"`
	ReviewModelPolicy    ReviewModelPolicy `json:"review_model_policy"`
	AllowNativeSubagents bool              `json:"allow_native_subagents"`
	AuthoritySource      string            `json:"authority_source"`
}

// NewExecutionProfile resolves project agent settings into a complete profile.
func NewExecutionProfile(config AgentConfig, authority string) (ExecutionProfile, error) {
	model := strings.TrimSpace(config.Model)
	if model == "" {
		model = ExecutionProfileAgentDefault
	}
	reasoning := strings.TrimSpace(config.ReasoningEffort)
	if reasoning == "" {
		reasoning = ExecutionProfileAgentDefault
	}
	policy := ReviewModelSameModel
	reviewModel := strings.TrimSpace(config.ReviewModel)
	if reviewModel != "" {
		policy = ReviewModelExplicit
	}
	p := ExecutionProfile{
		Version: ExecutionProfileVersion, Model: model, ReasoningEffort: reasoning,
		FastMode: config.FastMode, ReviewModel: reviewModel, ReviewModelPolicy: policy,
		AllowNativeSubagents: config.AllowNativeSubagents,
		AuthoritySource:      strings.TrimSpace(authority),
	}
	if p.AuthoritySource == "" {
		return ExecutionProfile{}, errors.New("execution profile authority_source is required")
	}
	p.Hash = p.DeterministicHash()
	return p, p.Validate()
}

func (p ExecutionProfile) canonical() executionProfileCanonical {
	return executionProfileCanonical{
		Version: p.Version, Model: p.Model, ReasoningEffort: p.ReasoningEffort,
		FastMode: p.FastMode, ReviewModel: p.ReviewModel, ReviewModelPolicy: p.ReviewModelPolicy,
		AllowNativeSubagents: p.AllowNativeSubagents, AuthoritySource: p.AuthoritySource,
	}
}

// DeterministicHash returns the canonical SHA-256 excluding the Hash field.
func (p ExecutionProfile) DeterministicHash() string {
	b, _ := json.Marshal(p.canonical())
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// IsZero reports whether no profile has been persisted.
func (p ExecutionProfile) IsZero() bool { return p == (ExecutionProfile{}) }

// Validate checks completeness, policy consistency, and hash integrity.
func (p ExecutionProfile) Validate() error {
	if p.IsZero() {
		return ErrExecutionProfileMissing
	}
	if p.Version != ExecutionProfileVersion {
		return fmt.Errorf("unsupported execution profile version %q", p.Version)
	}
	if strings.TrimSpace(p.Model) == "" || strings.TrimSpace(p.ReasoningEffort) == "" || strings.TrimSpace(p.AuthoritySource) == "" {
		return errors.New("execution profile model, reasoning_effort, and authority_source are required")
	}
	switch p.ReviewModelPolicy {
	case ReviewModelSameModel:
		if p.ReviewModel != "" {
			return errors.New("same-model review policy cannot set review_model")
		}
	case ReviewModelExplicit:
		if strings.TrimSpace(p.ReviewModel) == "" {
			return errors.New("explicit review policy requires review_model")
		}
	default:
		return fmt.Errorf("invalid review_model_policy %q", p.ReviewModelPolicy)
	}
	if p.Hash == "" || p.Hash != p.DeterministicHash() {
		return ErrExecutionProfileDrift
	}
	return nil
}

// EffectiveReviewModel resolves the same-model/explicit review policy.
func (p ExecutionProfile) EffectiveReviewModel() string {
	if p.ReviewModelPolicy == ReviewModelExplicit {
		return p.ReviewModel
	}
	return p.Model
}

// AgentConfig converts pinned execution properties to adapter configuration.
func (p ExecutionProfile) AgentConfig() AgentConfig {
	config := AgentConfig{FastMode: p.FastMode, ReviewModel: p.ReviewModel, AllowNativeSubagents: p.AllowNativeSubagents}
	if p.Model != ExecutionProfileAgentDefault {
		config.Model = p.Model
	}
	if p.ReasoningEffort != ExecutionProfileAgentDefault {
		config.ReasoningEffort = p.ReasoningEffort
	}
	return config
}

// ExecutionProfileChange is the durable audit record for a human mutation.
type ExecutionProfileChange struct {
	SessionID  SessionID        `json:"session_id"`
	OldProfile ExecutionProfile `json:"old_profile"`
	NewProfile ExecutionProfile `json:"new_profile"`
	Authority  string           `json:"authority"`
	Reason     string           `json:"reason"`
	ChangedAt  time.Time        `json:"changed_at"`
}

// AuthorizeExecutionProfileChange validates and stamps an explicit human event.
func AuthorizeExecutionProfileChange(sessionID SessionID, oldProfile, requested ExecutionProfile, authority, reason string, at time.Time) (ExecutionProfileChange, error) {
	if strings.TrimSpace(authority) != "human" {
		return ExecutionProfileChange{}, ErrExecutionProfileUnauthorized
	}
	if strings.TrimSpace(reason) == "" {
		return ExecutionProfileChange{}, errors.New("execution profile change reason is required")
	}
	requested.AuthoritySource = "human"
	requested.Hash = requested.DeterministicHash()
	if err := oldProfile.Validate(); err != nil {
		return ExecutionProfileChange{}, fmt.Errorf("old profile: %w", err)
	}
	if err := requested.Validate(); err != nil {
		return ExecutionProfileChange{}, fmt.Errorf("new profile: %w", err)
	}
	return ExecutionProfileChange{SessionID: sessionID, OldProfile: oldProfile, NewProfile: requested, Authority: "human", Reason: strings.TrimSpace(reason), ChangedAt: at.UTC()}, nil
}
