package sqlite

import (
	"strings"
	"testing"
)

func TestUsageIndexes(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, test := range []struct {
		name   string
		layout string
	}{
		{"idx_model_usage_events_usage_source", "usage_source_id:0"},
		{"idx_usage_sources_codex_native_latest", "kind:0,native_session_id:0,binding_id:0,generation:1,id:1"},
	} {
		var layout string
		err := db.QueryRow(`
			SELECT group_concat(name || ':' || desc, ',')
			FROM (
				SELECT name, desc
				FROM pragma_index_xinfo(?)
				WHERE key = 1
				ORDER BY seqno
			)
		`, test.name).Scan(&layout)
		if err != nil || layout != test.layout {
			t.Errorf("%s layout = %q, %v; want %q", test.name, layout, err, test.layout)
		}
	}

	const indexName = "idx_usage_sources_codex_native_latest"
	planRows, err := db.Query(`
		EXPLAIN QUERY PLAN
		SELECT latest.id
		FROM usage_sources latest
		WHERE latest.kind = 'codex_rollout'
		  AND latest.native_session_id = ?
		  AND latest.binding_id = ?
		ORDER BY latest.generation DESC, latest.id DESC
		LIMIT 1
	`, "22222222-2222-4222-8222-222222222222", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = planRows.Close() }()
	var details []string
	for planRows.Next() {
		var id, parent, unused int
		var detail string
		if err := planRows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	if err := planRows.Err(); err != nil {
		t.Fatal(err)
	}
	plan := strings.Join(details, "\n")
	if !strings.Contains(plan, indexName) || strings.Contains(plan, "USE TEMP B-TREE") {
		t.Fatalf("latest Codex lookup plan did not use %s:\n%s", indexName, plan)
	}
}
