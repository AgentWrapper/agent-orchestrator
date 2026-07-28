package testgate

import (
	"strings"
	"testing"
	"time"
)

func TestParseManifestAcceptsTestInfraYAML(t *testing.T) {
	raw := []byte(`
build:
  - npm ci
  - npm run build
run: npm run dev
ready:
  - curl -fsS http://127.0.0.1:3000/health
services:
  - type: postgres
    name: db
    image: postgres:16
  - redis
env:
  NODE_ENV: test
tests:
  own:
    - npm test -- --runInBand
  smoke: npm run smoke
junit:
  - reports/junit.xml
touch_map:
  frontend/**:
    - npm test -- frontend
  backend/**:
    - go test ./...
timeout: 90s
`)

	got, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("ParseManifest err = %v", err)
	}
	if len(got.Build) != 2 || got.Build[0] != "npm ci" || got.Run[0] != "npm run dev" {
		t.Fatalf("commands = build:%#v run:%#v", got.Build, got.Run)
	}
	if len(got.Services) != 2 || got.Services[0].Type != "postgres" || got.Services[1].Type != "redis" {
		t.Fatalf("services = %+v", got.Services)
	}
	if got.Env["NODE_ENV"] != "test" || got.Tests.Smoke[0] != "npm run smoke" {
		t.Fatalf("env/tests = %#v %#v", got.Env, got.Tests)
	}
	if got.TimeoutDuration != 90*time.Second {
		t.Fatalf("timeout = %v, want 90s", got.TimeoutDuration)
	}
	if got.Hash == "" || got.Hash != ManifestHash(raw) {
		t.Fatalf("hash = %q, want manifest hash", got.Hash)
	}
}

func TestParseManifestRejectsUnknownPrototypeBillingFields(t *testing.T) {
	_, err := ParseManifest([]byte(`
run: npm test
not_entitled: true
`))
	if err == nil {
		t.Fatal("ParseManifest err = nil, want unknown field rejection")
	}
	if !strings.Contains(err.Error(), "not_entitled") {
		t.Fatalf("err = %v, want not_entitled", err)
	}
}

func TestParseManifestRejectsMissingRunCommand(t *testing.T) {
	_, err := ParseManifest([]byte(`timeout: 1m`))
	if err == nil {
		t.Fatal("ParseManifest err = nil, want missing run command")
	}
}

func TestParseManifestTimeout(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{name: "go duration", raw: "2m30s", want: 150 * time.Second},
		{name: "integer seconds", raw: "45", want: 45 * time.Second},
		{name: "blank", raw: "", want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseManifestTimeout(tt.raw)
			if err != nil {
				t.Fatalf("ParseManifestTimeout err = %v", err)
			}
			if got != tt.want {
				t.Fatalf("duration = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseManifestTimeoutRejectsInvalidValue(t *testing.T) {
	_, err := ParseManifestTimeout("soon")
	if err == nil {
		t.Fatal("ParseManifestTimeout err = nil, want invalid timeout")
	}
}
