package metrics

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

type fakeTelemetry struct {
	rows []gen.TelemetryEvent
	err  error
}

func (f fakeTelemetry) ListTelemetryEventsSince(_ context.Context, _ time.Time, limit int64) ([]gen.TelemetryEvent, error) {
	if f.err != nil {
		return nil, f.err
	}
	// Mimic the SQL LIMIT so tests exercise the real truncation path.
	if limit > 0 && int64(len(f.rows)) > limit {
		return f.rows[:limit], nil
	}
	return f.rows, nil
}

func TestStoreCostAggregatorSums(t *testing.T) {
	agg := NewStoreCostAggregator(fakeTelemetry{rows: []gen.TelemetryEvent{
		{PayloadJson: `{"input_tokens":100,"output_tokens":50,"cost_usd":0.25}`},
		{PayloadJson: `{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cost_usd":0.05}`},
		{PayloadJson: `{"unrelated":"field"}`}, // no cost fields → skipped
		{PayloadJson: `not json`},              // malformed → skipped
		{PayloadJson: ``},                      // empty → skipped
	}})
	c, err := agg.Aggregate(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if c.InputTokens != 110 || c.OutputTokens != 55 {
		t.Errorf("token sums wrong: %+v", c)
	}
	// total: row1 derived 150 + row2 explicit 15 = 165.
	if c.TotalTokens != 165 {
		t.Errorf("total tokens = %d, want 165", c.TotalTokens)
	}
	if c.CostUSD != 0.30 {
		t.Errorf("cost = %v, want 0.30", c.CostUSD)
	}
	if c.Events != 2 {
		t.Errorf("events = %d, want 2 (only cost-bearing rows counted)", c.Events)
	}
}

func TestStoreCostAggregatorNilReader(t *testing.T) {
	var agg *StoreCostAggregator
	if c, err := agg.Aggregate(context.Background(), time.Now()); err != nil || c.Events != 0 {
		t.Fatalf("nil aggregator must be a clean no-op, got c=%+v err=%v", c, err)
	}
}

func TestParseCostPayloadTotalDerivation(t *testing.T) {
	in, out, total, cost, ok := parseCostPayload(`{"input_tokens":3,"output_tokens":4}`)
	if !ok {
		t.Fatal("want ok")
	}
	if in != 3 || out != 4 || total != 7 || cost != 0 {
		t.Errorf("got in=%d out=%d total=%d cost=%v", in, out, total, cost)
	}
}

func TestParseCostPayloadRejectsNonFiniteAndNegative(t *testing.T) {
	cases := []string{
		`{"cost_usd":-1.5}`,      // negative cost
		`{"input_tokens":-10}`,   // negative tokens
		`{"input_tokens":1e300}`, // finite but out of range → int64() would be UB
		`{"cost_usd":1e300}`,     // finite but absurd → would risk +Inf on sum
	}
	for _, p := range cases {
		if _, _, _, _, ok := parseCostPayload(p); ok {
			// A payload whose only recognised field is non-finite/negative must
			// not be treated as a cost-bearing event.
			t.Errorf("payload %q must be rejected (non-finite/negative)", p)
		}
	}
	// NaN cannot be expressed in JSON literals, but a mixed payload with a valid
	// field and a negative one must drop only the bad field.
	in, out, _, cost, ok := parseCostPayload(`{"input_tokens":5,"cost_usd":-9}`)
	if !ok {
		t.Fatal("want ok for the valid input_tokens field")
	}
	if in != 5 || out != 0 || cost != 0 {
		t.Errorf("negative cost must be dropped: in=%d out=%d cost=%v", in, out, cost)
	}
}

func TestStoreCostAggregatorMarksTruncated(t *testing.T) {
	newAgg := func(n int) *StoreCostAggregator {
		rows := make([]gen.TelemetryEvent, n)
		for i := range rows {
			rows[i] = gen.TelemetryEvent{PayloadJson: `{"input_tokens":1}`}
		}
		a := NewStoreCostAggregator(fakeTelemetry{rows: rows})
		a.limit = 5 // small deterministic cap; the fake honours it (fetches limit+1)
		return a
	}

	// More rows than the cap -> truncated, and only the newest `limit` aggregated.
	c, err := newAgg(20).Aggregate(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if !c.Truncated {
		t.Error("more rows than the cap must set Truncated")
	}
	if c.InputTokens != 5 {
		t.Errorf("only the newest 5 events must be aggregated, got InputTokens=%d", c.InputTokens)
	}

	// Exactly the cap -> NOT truncated (boundary must not false-positive).
	c2, err := newAgg(5).Aggregate(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if c2.Truncated {
		t.Error("exactly the cap with nothing dropped must NOT set Truncated")
	}
	if c2.InputTokens != 5 {
		t.Errorf("all 5 events must be aggregated, got %d", c2.InputTokens)
	}

	// Below the cap -> not truncated.
	c3, err := newAgg(3).Aggregate(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if c3.Truncated {
		t.Error("under the cap must not set Truncated")
	}
}
