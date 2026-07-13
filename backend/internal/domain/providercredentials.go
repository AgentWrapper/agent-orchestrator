package domain

// ProviderCredentials holds user-scoped credentials for a Claude-compatible
// provider. Stored as ~/.ao/provider-credentials.json. All fields are optional;
// unset fields leave the spawned session to inherit the daemon process env.
type ProviderCredentials struct {
	// APIKey is forwarded as ANTHROPIC_API_KEY (or the provider's equivalent).
	APIKey string `json:"apiKey,omitempty"`
	// BaseURL overrides the provider endpoint (ANTHROPIC_BASE_URL).
	BaseURL string `json:"baseURL,omitempty"`
	// AuthToken overrides the bearer token (ANTHROPIC_AUTH_TOKEN).
	AuthToken string `json:"authToken,omitempty"`
}

// IsZero reports whether the credentials carry no settings.
func (c ProviderCredentials) IsZero() bool {
	return c == ProviderCredentials{}
}

// Env returns the env var map to inject at session spawn. Only non-empty
// fields are included; project.Config.Env entries win when they overlap
// (callers merge this first, then project env on top).
func (c ProviderCredentials) Env() map[string]string {
	out := make(map[string]string, 3)
	if c.APIKey != "" {
		out["ANTHROPIC_API_KEY"] = c.APIKey
	}
	if c.BaseURL != "" {
		out["ANTHROPIC_BASE_URL"] = c.BaseURL
	}
	if c.AuthToken != "" {
		out["ANTHROPIC_AUTH_TOKEN"] = c.AuthToken
	}
	return out
}
