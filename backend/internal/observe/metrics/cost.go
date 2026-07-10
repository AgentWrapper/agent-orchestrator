package metrics

import (
	"context"
	"encoding/json"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// telemetryReader is the store read surface the cost aggregator needs.
type telemetryReader interface {
	ListTelemetryEventsSince(ctx context.Context, since time.Time, limit int64) ([]gen.TelemetryEvent, error)
}

// costScanLimit bounds how many telemetry rows one aggregation reads so a busy
// fleet cannot make a tick scan an unbounded backlog.
const costScanLimit = 10000

// StoreCostAggregator sums token/cost fields from telemetry_event payloads over
// a rolling window. It reads the allowlisted numeric payload keys the agent
// harnesses emit (input_tokens/output_tokens/total_tokens/cost_usd) and ignores
// events that carry none of them, so non-cost telemetry does not skew the totals
// or the scanned-event count.
type StoreCostAggregator struct {
	reader telemetryReader
	limit  int64
}

// NewStoreCostAggregator constructs a cost aggregator over the telemetry store.
func NewStoreCostAggregator(reader telemetryReader) *StoreCostAggregator {
	return &StoreCostAggregator{reader: reader, limit: costScanLimit}
}

// Aggregate sums the cost/token payload fields across telemetry events with
// occurred_at >= since.
func (a *StoreCostAggregator) Aggregate(ctx context.Context, since time.Time) (Cost, error) {
	if a == nil || a.reader == nil {
		return Cost{}, nil
	}
	rows, err := a.reader.ListTelemetryEventsSince(ctx, since, a.limit)
	if err != nil {
		return Cost{}, err
	}
	var c Cost
	for _, row := range rows {
		in, out, total, cost, ok := parseCostPayload(row.PayloadJson)
		if !ok {
			continue
		}
		c.InputTokens += in
		c.OutputTokens += out
		c.TotalTokens += total
		c.CostUSD += cost
		c.Events++
	}
	return c, nil
}

// parseCostPayload extracts token/cost fields from a telemetry payload JSON
// object. It returns ok=false when the payload is not a JSON object or carries
// none of the recognised fields. When total_tokens is absent it is derived from
// input+output so callers always get a usable total.
func parseCostPayload(payload string) (in, out, total int64, cost float64, ok bool) {
	if payload == "" {
		return 0, 0, 0, 0, false
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return 0, 0, 0, 0, false
	}
	inV, inOK := numField(m, "input_tokens")
	outV, outOK := numField(m, "output_tokens")
	totV, totOK := numField(m, "total_tokens")
	costV, costOK := numField(m, "cost_usd")
	if !inOK && !outOK && !totOK && !costOK {
		return 0, 0, 0, 0, false
	}
	in = int64(inV)
	out = int64(outV)
	if totOK {
		total = int64(totV)
	} else {
		total = in + out
	}
	return in, out, total, costV, true
}

// numField reads a numeric field from a decoded JSON object, accepting the
// float64 that encoding/json produces for JSON numbers.
func numField(m map[string]any, key string) (float64, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	return f, true
}
