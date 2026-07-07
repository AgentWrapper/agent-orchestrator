package domain

import "strings"

// ModelProvider identifies the vendor family a model string or agent harness
// belongs to. Model names are provider-specific — a Claude model is invalid for
// a Codex agent and vice versa — so model resolution keys the model to the
// spawn's harness through this family. ProviderUnknown means "not classified"
// and is treated permissively: novel models and the many harnesses AO has not
// mapped are passed through as configured rather than rejected.
type ModelProvider string

// The model vendor families AO classifies. Everything else is ProviderUnknown.
const (
	ProviderUnknown   ModelProvider = ""
	ProviderAnthropic ModelProvider = "anthropic"
	ProviderOpenAI    ModelProvider = "openai"
	ProviderFugu      ModelProvider = "fugu"
)

// ClassifyModelProvider infers the vendor family of a model string from
// well-known name fragments. It is deliberately conservative: an unrecognized
// model returns ProviderUnknown so callers stay permissive rather than reject a
// model AO simply has not seen. Ordering matters — the fugu family reuses the
// Codex binary but its own model namespace, so it is matched before the OpenAI
// "codex" fragment.
func ClassifyModelProvider(model string) ModelProvider {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return ProviderUnknown
	}
	switch {
	case strings.Contains(m, "fugu"):
		return ProviderFugu
	case strings.Contains(m, "claude"),
		strings.Contains(m, "opus"),
		strings.Contains(m, "sonnet"),
		strings.Contains(m, "haiku"),
		strings.Contains(m, "fable"):
		return ProviderAnthropic
	case strings.Contains(m, "gpt"),
		strings.Contains(m, "codex"),
		strings.HasPrefix(m, "o1"),
		strings.HasPrefix(m, "o3"),
		strings.HasPrefix(m, "o4"):
		return ProviderOpenAI
	default:
		return ProviderUnknown
	}
}

// CompatibleWith reports whether a model of provider p may be passed to a
// harness of provider harnessProvider. It is permissive by design: an unknown
// provider on either side (an unclassified model or an unmapped harness) is
// always compatible, so guarding only ever fires on a known-vs-known mismatch.
func (p ModelProvider) CompatibleWith(harnessProvider ModelProvider) bool {
	if p == ProviderUnknown || harnessProvider == ProviderUnknown {
		return true
	}
	return p == harnessProvider
}
