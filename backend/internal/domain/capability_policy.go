package domain

// ImplementationCapability names a formal engineering operation guarded by
// AO's independent-worker policy.
type ImplementationCapability string

// Formal implementation capabilities restricted to independent AO workers.
const (
	CapabilityRepositoryEdit             ImplementationCapability = "repository_edit"
	CapabilityImplementationVerification ImplementationCapability = "implementation_verification"
	CapabilityCommit                     ImplementationCapability = "commit"
	CapabilityPush                       ImplementationCapability = "push"
	CapabilityClaimPR                    ImplementationCapability = "claim_pr"
	CapabilityWritableWorktree           ImplementationCapability = "writable_worktree"
)

// IndependentWorkerPolicyReason is stable audit vocabulary for policy
// denials. Keep it machine-readable; human-facing explanations can add detail.
const IndependentWorkerPolicyReason = "formal_implementation_requires_independent_ao_worker"

// AllowsImplementation reports whether a capability class may perform formal
// implementation. Only a separately launched AO worker crosses this boundary.
func (c CapabilityClass) AllowsImplementation() bool {
	return c == CapabilityClassAOWorker
}

// EffectiveCapabilityClass preserves compatibility with sessions created
// before capability_class was persisted while keeping new records explicit.
func EffectiveCapabilityClass(rec SessionRecord) CapabilityClass {
	if rec.Metadata.CapabilityClass != "" {
		return rec.Metadata.CapabilityClass
	}
	return CapabilityClassForKind(rec.Kind)
}
