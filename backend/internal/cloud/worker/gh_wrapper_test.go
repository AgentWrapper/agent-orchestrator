package worker

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHubWrapperUsesHeartbeatRefreshedWorkerToken(t *testing.T) {
	fixture := newGitHubWrapperFixture(t)
	if err := os.WriteFile(
		filepath.Join(fixture.dataDir, "worker-token"),
		[]byte("heartbeat-refreshed-token\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	output, err := fixture.command(t, false).CombinedOutput()
	if err != nil {
		t.Fatalf("run GitHub wrapper: %v: %s", err, output)
	}
	curlArguments, err := os.ReadFile(fixture.curlArgumentsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(
		string(curlArguments),
		"Authorization: Worker heartbeat-refreshed-token\n",
	) {
		t.Fatalf("curl arguments = %q", curlArguments)
	}
	if strings.Contains(string(curlArguments), "startup-worker-token") {
		t.Fatalf("GitHub wrapper reused its startup token: %q", curlArguments)
	}
	githubToken, err := os.ReadFile(fixture.githubTokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(githubToken) != "installation-token\n" {
		t.Fatalf("GH_TOKEN = %q, want installation token", githubToken)
	}
	githubArguments, err := os.ReadFile(fixture.githubArgumentsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(githubArguments) != "pr\ncreate\n--title\nworker change\n" {
		t.Fatalf("gh arguments = %q", githubArguments)
	}
	githubRepository, err := os.ReadFile(fixture.githubRepositoryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(githubRepository) != "amoreX/flowlens\n" {
		t.Fatalf("GH_REPO = %q, want amoreX/flowlens", githubRepository)
	}
}

func TestGitHubWrapperRefusesUnauthenticatedFallbackAfterBrokerFailure(t *testing.T) {
	fixture := newGitHubWrapperFixture(t)
	if err := os.WriteFile(
		filepath.Join(fixture.dataDir, "worker-token"),
		[]byte("heartbeat-refreshed-token\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	output, err := fixture.command(t, true).CombinedOutput()
	if err == nil {
		t.Fatalf("GitHub wrapper succeeded after broker failure: %s", output)
	}
	if !strings.Contains(string(output), "refusing unauthenticated gh fallback") {
		t.Fatalf("GitHub wrapper error = %q", output)
	}
	if _, statErr := os.Stat(fixture.githubTokenPath); !os.IsNotExist(statErr) {
		t.Fatalf("real gh was invoked after broker failure: %v", statErr)
	}
}

type githubWrapperFixture struct {
	wrapperPath          string
	binDir               string
	dataDir              string
	workspaceDir         string
	realGitHubPath       string
	curlArgumentsPath    string
	githubArgumentsPath  string
	githubRepositoryPath string
	githubTokenPath      string
}

func newGitHubWrapperFixture(t *testing.T) githubWrapperFixture {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	fixtureRoot := t.TempDir()
	binDir := filepath.Join(fixtureRoot, "bin")
	dataDir := filepath.Join(fixtureRoot, "data")
	workspaceDir := filepath.Join(fixtureRoot, "workspace")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, workspaceDir, nil, "init", "-q")
	runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"remote",
		"add",
		"origin",
		"https://cloud.example/api/cloud/v1/git/amoreX/flowlens.git",
	)
	fixture := githubWrapperFixture{
		wrapperPath:          filepath.Join(root, "ao-cloud", "docker", "worker-gh-wrapper.sh"),
		binDir:               binDir,
		dataDir:              dataDir,
		workspaceDir:         workspaceDir,
		realGitHubPath:       filepath.Join(binDir, "real-gh"),
		curlArgumentsPath:    filepath.Join(fixtureRoot, "curl-arguments"),
		githubArgumentsPath:  filepath.Join(fixtureRoot, "gh-arguments"),
		githubRepositoryPath: filepath.Join(fixtureRoot, "gh-repository"),
		githubTokenPath:      filepath.Join(fixtureRoot, "gh-token"),
	}
	writeExecutable(t, filepath.Join(binDir, "curl"), `#!/bin/sh
printf '%s\n' "$@" > "$MOCK_CURL_ARGUMENTS"
if [ "${MOCK_CURL_FAIL:-}" = "1" ]; then
  echo "mock broker returned 401" >&2
  exit 22
fi
printf '{"token":"installation-token"}'
`)
	writeExecutable(t, filepath.Join(binDir, "jq"), `#!/bin/sh
cat >/dev/null
printf 'installation-token\n'
`)
	writeExecutable(t, fixture.realGitHubPath, `#!/bin/sh
printf '%s\n' "${GH_TOKEN:-}" > "$MOCK_GH_TOKEN"
printf '%s\n' "${GH_REPO:-}" > "$MOCK_GH_REPOSITORY"
printf '%s\n' "$@" > "$MOCK_GH_ARGUMENTS"
`)
	return fixture
}

func (f githubWrapperFixture) command(t *testing.T, brokerFailure bool) *exec.Cmd {
	t.Helper()
	command := exec.Command(
		"/bin/sh",
		f.wrapperPath,
		"pr",
		"create",
		"--title",
		"worker change",
	)
	command.Dir = f.workspaceDir
	command.Env = append(os.Environ(),
		"PATH="+f.binDir+":/usr/bin:/bin",
		"AO_GH_REAL_BINARY="+f.realGitHubPath,
		"AO_CLOUD_PUBLIC_URL=https://cloud.example",
		"AO_SESSION_ID=session-one",
		"AO_WORKER_TOKEN=startup-worker-token",
		"AO_DATA_DIR="+f.dataDir,
		"MOCK_CURL_ARGUMENTS="+f.curlArgumentsPath,
		"MOCK_GH_ARGUMENTS="+f.githubArgumentsPath,
		"MOCK_GH_REPOSITORY="+f.githubRepositoryPath,
		"MOCK_GH_TOKEN="+f.githubTokenPath,
	)
	if brokerFailure {
		command.Env = append(command.Env, "MOCK_CURL_FAIL=1")
	}
	return command
}

func writeExecutable(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
}
