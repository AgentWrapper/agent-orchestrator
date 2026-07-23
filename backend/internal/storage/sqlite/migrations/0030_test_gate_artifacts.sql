-- Persist runtime test-gate artifacts that connect AO review findings to
-- pod execution evidence and the fused PR verdict.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE review_finding (
    id               TEXT PRIMARY KEY,
    review_run_id    TEXT NOT NULL REFERENCES review_run (id) ON DELETE CASCADE,
    file             TEXT NOT NULL DEFAULT '',
    line             INTEGER NOT NULL DEFAULT 0,
    severity         TEXT NOT NULL DEFAULT '' CHECK (severity IN ('', 'low', 'medium', 'high', 'critical')),
    title            TEXT NOT NULL DEFAULT '',
    claim            TEXT NOT NULL DEFAULT '',
    failure_scenario TEXT NOT NULL DEFAULT '',
    behavioral       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_review_finding_run ON review_finding (review_run_id, created_at, id);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE test_gate_run (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    review_run_id   TEXT NOT NULL DEFAULT '',
    pr_url          TEXT NOT NULL,
    target_sha      TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL CHECK (kind IN ('baseline', 'targeted')),
    classification  TEXT NOT NULL CHECK (classification IN ('passed', 'app_failed', 'infra', 'not_configured')),
    summary         TEXT NOT NULL DEFAULT '',
    artifacts_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json)),
    pod_handle_id   TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_test_gate_run_latest ON test_gate_run (session_id, pr_url, target_sha, kind, created_at);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE test_gate_evidence (
    id             TEXT PRIMARY KEY,
    test_run_id    TEXT NOT NULL REFERENCES test_gate_run (id) ON DELETE CASCADE,
    finding_id     TEXT NOT NULL REFERENCES review_finding (id) ON DELETE CASCADE,
    source         TEXT NOT NULL DEFAULT 'test-infra' CHECK (source IN ('static', 'test-infra')),
    outcome        TEXT NOT NULL CHECK (outcome IN ('not_tested', 'confirmed', 'refuted')),
    summary        TEXT NOT NULL DEFAULT '',
    artifacts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json)),
    created_at     TIMESTAMP NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_test_gate_evidence_run ON test_gate_evidence (test_run_id, created_at, id);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE fused_verdict (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    review_run_id  TEXT NOT NULL DEFAULT '',
    test_run_id    TEXT NOT NULL DEFAULT '',
    pr_url         TEXT NOT NULL,
    target_sha     TEXT NOT NULL DEFAULT '',
    outcome        TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'app_failed', 'neutral')),
    blocking       INTEGER NOT NULL DEFAULT 0,
    summary        TEXT NOT NULL DEFAULT '',
    findings_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings_json)),
    created_at     TIMESTAMP NOT NULL,
    UNIQUE (session_id, pr_url, target_sha)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE fused_verdict;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE test_gate_evidence;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE test_gate_run;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE review_finding;
-- +goose StatementEnd
