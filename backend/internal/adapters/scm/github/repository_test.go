package github

import "testing"

func TestParseRepository(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		remote     string
		resolve    func(string) (string, bool)
		wantHost   string
		wantRepo   string
		wantParsed bool
	}{
		{
			name:       "https github",
			remote:     "https://github.com/acme/demo.git",
			wantHost:   "github.com",
			wantRepo:   "acme/demo",
			wantParsed: true,
		},
		{
			name:       "scp github",
			remote:     "git@github.com:acme/demo.git",
			wantHost:   "github.com",
			wantRepo:   "acme/demo",
			wantParsed: true,
		},
		{
			name:       "scp ssh alias",
			remote:     "git@github-work:acme/demo.git",
			resolve:    func(string) (string, bool) { return "github.com", true },
			wantHost:   "github.com",
			wantRepo:   "acme/demo",
			wantParsed: true,
		},
		{
			name:   "ssh url alias",
			remote: "ssh://git@github-work/acme/demo.git",
			resolve: func(string) (string, bool) {
				return "github.com", true
			},
			wantHost:   "github.com",
			wantRepo:   "acme/demo",
			wantParsed: true,
		},
		{
			name:   "non github ssh alias",
			remote: "git@gitlab-work:acme/demo.git",
			resolve: func(string) (string, bool) {
				return "gitlab.com", true
			},
			wantParsed: false,
		},
		{
			name:       "unresolved ssh alias",
			remote:     "git@code-host:acme/demo.git",
			resolve:    func(string) (string, bool) { return "", false },
			wantParsed: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			provider, err := NewProvider(ProviderOptions{
				Client:          NewClient(ClientOptions{}),
				SSHHostResolver: tt.resolve,
			})
			if err != nil {
				t.Fatalf("NewProvider: %v", err)
			}
			repo, ok := provider.ParseRepository(tt.remote)
			if ok != tt.wantParsed {
				t.Fatalf("ParseRepository(%q) ok = %v, want %v; repo=%+v", tt.remote, ok, tt.wantParsed, repo)
			}
			if !tt.wantParsed {
				return
			}
			if repo.Provider != "github" || repo.Host != tt.wantHost || repo.Repo != tt.wantRepo {
				t.Fatalf("ParseRepository(%q) = %+v, want host=%q repo=%q", tt.remote, repo, tt.wantHost, tt.wantRepo)
			}
		})
	}
}

func TestParseRepositoryCachesSSHHostResolution(t *testing.T) {
	t.Parallel()

	calls := 0
	provider, err := NewProvider(ProviderOptions{
		Client: NewClient(ClientOptions{}),
		SSHHostResolver: func(host string) (string, bool) {
			calls++
			return "github.com", host == "github-work"
		},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}

	for range 2 {
		if _, ok := provider.ParseRepository("git@github-work:acme/demo.git"); !ok {
			t.Fatal("ParseRepository returned ok=false")
		}
	}
	if calls != 1 {
		t.Fatalf("resolver calls = %d, want 1", calls)
	}
}

func TestSSHConfigHostname(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config string
		want   string
		ok     bool
	}{
		{name: "hostname", config: "user git\nhostname github.com\nport 22\n", want: "github.com", ok: true},
		{name: "case insensitive", config: "HostName github.com\n", want: "github.com", ok: true},
		{name: "missing", config: "user git\nport 22\n"},
		{name: "blank", config: "hostname   \n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := sshConfigHostname(tt.config)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("sshConfigHostname() = %q, %v; want %q, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}
