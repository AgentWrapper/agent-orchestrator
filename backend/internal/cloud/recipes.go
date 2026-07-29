package cloud

// Harness recipes: how to install an agent CLI inside a fresh sandbox and port
// the user's local credential in so it runs headless. Ported from the TypeScript
// recipe registry; kept as in-code Go values (not YAML) so the set ships with the
// binary and stays type-checked. Add a harness by adding a Recipe.

// AuthMode is how a harness authenticates inside the sandbox.
type AuthMode string

const (
	// AuthOAuthFile ports one or more local credential files into the sandbox.
	AuthOAuthFile AuthMode = "oauth-file"
	// AuthEnvKey passes an API key via env (no file port).
	AuthEnvKey AuthMode = "env-key"
)

// CredSource locates a local credential: a file under $HOME, or a macOS Keychain
// generic-password service. Sources are tried in order until one resolves.
type CredSource struct {
	HomePath           string // path relative to the host $HOME
	MacKeychainService string // macOS Keychain generic-password service name
	EnvVar             string // env var holding the raw credential — used by the
	// headless hosted control plane, which has no $HOME file or Keychain; the
	// value is injected from Key Vault at deploy. Never logged.
}

// PortedFile is a credential file to upload into the sandbox (path relative to
// the sandbox user's home), sourced from the first CredSource that resolves.
type PortedFile struct {
	Remote string // e.g. ".claude/.credentials.json"
	Mode   string // chmod, e.g. "600" (empty = leave default)
	Local  []CredSource
}

// HeadlessSeed is a JSON file written into the sandbox to pre-accept prompts so
// the agent runs non-interactively (e.g. claude-code onboarding/bypass flags).
type HeadlessSeed struct {
	Remote string         // path relative to sandbox home
	JSON   map[string]any // marshaled to the file
}

// AuthConfig describes credential porting for a harness.
type AuthConfig struct {
	Mode        AuthMode
	PortedFiles []PortedFile
}

// Recipe is everything needed to stand a harness up inside a sandbox.
type Recipe struct {
	ID      string
	Binary  string
	Install []string // shell commands, run in order (SKIPPED when Snapshot is set)
	// Snapshot is a pre-baked Daytona snapshot with this harness (+tmux) already
	// installed. When set, provisioning uses it and skips the Install steps and
	// tmux apt — cutting spin-up from minutes to ~15-20s. Build it once with
	// scripts/bake-snapshot (or the @daytona/sdk). Empty → default snapshot + install.
	Snapshot     string
	Auth         AuthConfig        // credential porting
	Env          map[string]string // extra env for the agent-host daemon
	PathAdd      []string          // dirs prepended to PATH (~ expands to sandbox home)
	HeadlessSeed []HeadlessSeed    // JSON seeds written before boot
	Verified     bool              // proven end-to-end in a real sandbox
	// EgressDomains are the harness-specific hostnames the sandbox must reach
	// (model API, package registries). Combined with the base set + the control
	// plane host to form the sandbox's egress allowlist in hosted mode. Wildcards
	// allowed (leading "*"). Empty for credential-free harnesses.
	EgressDomains []string
}

// baseEgressDomains are the hosts EVERY harness sandbox needs: the git host (for
// clone/gh) and apt mirrors (best-effort gh/git install on the non-baked path).
// Wildcards keep the list well under Daytona's 20-entry cap.
var baseEgressDomains = []string{
	"*.github.com",
	"*.githubusercontent.com",
	"*.debian.org",
	"*.ubuntu.com",
}

// recipes is the registry keyed by harness id.
var recipes = map[string]Recipe{
	"claude-code": {
		ID:            "claude-code",
		Binary:        "claude",
		Install:       []string{"curl -fsSL https://claude.ai/install.sh | bash"},
		Snapshot:      "ao-claude-code-v1", // pre-baked: claude + tmux + git (see scripts/bake-snapshot)
		EgressDomains: []string{"*.anthropic.com", "*.npmjs.org", "claude.ai"},
		Auth: AuthConfig{
			Mode: AuthOAuthFile,
			PortedFiles: []PortedFile{
				{
					Remote: ".claude/.credentials.json",
					Mode:   "600",
					// Hosted control plane: env var (from Key Vault). Local daemon:
					// $HOME file, then macOS login Keychain. First hit wins.
					Local: []CredSource{
						{EnvVar: "AO_CLAUDE_CREDENTIALS_JSON"},
						{HomePath: ".claude/.credentials.json"},
						{MacKeychainService: "Claude Code-credentials"},
					},
				},
			},
		},
		// Pre-accept onboarding + bypass-permissions so the CLI never blocks on an
		// interactive dialog in a headless sandbox.
		HeadlessSeed: []HeadlessSeed{
			{
				Remote: ".claude.json",
				JSON: map[string]any{
					"hasCompletedOnboarding":        true,
					"bypassPermissionsModeAccepted": true,
				},
			},
			{
				Remote: ".claude/settings.json",
				JSON: map[string]any{
					"permissions": map[string]any{"defaultMode": "bypassPermissions"},
				},
			},
		},
		Env:      map[string]string{"DISABLE_AUTOUPDATER": "1"},
		Verified: true,
	},
	// A no-credential harness used to smoke-test the provisioning path itself.
	"fake": {
		ID:       "fake",
		Binary:   "true",
		Install:  nil,
		Auth:     AuthConfig{Mode: AuthEnvKey},
		Verified: true,
	},
}

// recipeFor returns the recipe for a harness, or false if none is registered.
func recipeFor(harness string) (Recipe, bool) {
	r, ok := recipes[harness]
	return r, ok
}

// CloudCapableHarnesses lists harnesses that have a verified cloud recipe.
func CloudCapableHarnesses() []string { //nolint:revive // name intentionally disambiguates across packages; renaming ripples widely
	var out []string
	for id, r := range recipes {
		if r.Verified {
			out = append(out, id)
		}
	}
	return out
}
