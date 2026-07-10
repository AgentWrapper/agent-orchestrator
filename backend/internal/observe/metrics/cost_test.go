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

func (f fakeTelemetry) ListTelemetryEventsSince(context.Context, time.Time, int64) ([]gen.TelemetryEvent, error) {
	return f.rows, f.err
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
