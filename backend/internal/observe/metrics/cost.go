package metrics

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strings"
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

type parsedCostPayload struct {
	CostTotals
	Harness string
}

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
	// Fetch one more than the aggregation cap so we can tell "exactly limit rows,
	// nothing dropped" from "more than limit, oldest dropped" without a
	// false-positive on the boundary. Rows are newest-first, so the extra row (if
	// any) is the oldest and is discarded.
	fetch := a.limit
	if fetch > 0 {
		fetch++
	}
	rows, err := a.reader.ListTelemetryEventsSince(ctx, since, fetch)
	if err != nil {
		return Cost{}, err
	}
	c := Cost{ByProject: []ProjectCost{}, ByHarness: []HarnessCost{}}
	byProject := map[string]*ProjectCost{}
	byHarness := map[string]*HarnessCost{}
	if a.limit > 0 && int64(len(rows)) > a.limit {
		c.Truncated = true
		rows = rows[:a.limit] // aggregate only the newest a.limit events
	}
	for _, row := range rows {
		parsed, ok := parseCostPayload(row.PayloadJson)
		if !ok {
			continue
		}
		addCost(&c.CostTotals, parsed.CostTotals)
		if projectID, ok := nullString(row.ProjectID); ok {
			pc := byProject[projectID]
			if pc == nil {
				pc = &ProjectCost{ProjectID: projectID}
				byProject[projectID] = pc
			}
			addCost(&pc.CostTotals, parsed.CostTotals)
		}
		harness := parsed.Harness
		if harness == "" {
			harness = strings.TrimSpace(row.Source)
		}
		if harness != "" {
			hc := byHarness[harness]
			if hc == nil {
				hc = &HarnessCost{Harness: harness}
				byHarness[harness] = hc
			}
			addCost(&hc.CostTotals, parsed.CostTotals)
		}
	}
	c.ByProject = sortedProjectCosts(byProject)
	c.ByHarness = sortedHarnessCosts(byHarness)
	return c, nil
}

func addCost(c *CostTotals, add CostTotals) {
	c.InputTokens += add.InputTokens
	c.OutputTokens += add.OutputTokens
	c.TotalTokens += add.TotalTokens
	c.CostUSD += add.CostUSD
	c.Events += add.Events
}

func nullString(v sql.NullString) (string, bool) {
	if !v.Valid {
		return "", false
	}
	s := strings.TrimSpace(v.String)
	return s, s != ""
}

func sortedProjectCosts(m map[string]*ProjectCost) []ProjectCost {
	out := make([]ProjectCost, 0, len(m))
	for _, v := range m {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProjectID < out[j].ProjectID })
	return out
}

func sortedHarnessCosts(m map[string]*HarnessCost) []HarnessCost {
	out := make([]HarnessCost, 0, len(m))
	for _, v := range m {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Harness < out[j].Harness })
	return out
}

// parseCostPayload extracts token/cost fields from a telemetry payload JSON
// object. It returns ok=false when the payload is not a JSON object or carries
// none of the recognised fields. When total_tokens is absent it is derived from
// input+output so callers always get a usable total.
func parseCostPayload(payload string) (parsedCostPayload, bool) {
	if payload == "" {
		return parsedCostPayload{}, false
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return parsedCostPayload{}, false
	}
	inV, inOK := numField(m, "input_tokens")
	outV, outOK := numField(m, "output_tokens")
	totV, totOK := numField(m, "total_tokens")
	costV, costOK := numField(m, "cost_usd")
	if !inOK && !outOK && !totOK && !costOK {
		return parsedCostPayload{}, false
	}
	in := int64(inV)
	out := int64(outV)
	total := in + out
	if totOK {
		total = int64(totV)
	}
	return parsedCostPayload{
		CostTotals: CostTotals{
			InputTokens:  in,
			OutputTokens: out,
			TotalTokens:  total,
			CostUSD:      costV,
			Events:       1,
		},
		Harness: stringField(m, "harness"),
	}, true
}

// numField reads a numeric field from a decoded JSON object, accepting the
// float64 that encoding/json produces for JSON numbers. Payloads originate from
// agent harnesses, so non-finite (NaN/±Inf) and negative values are rejected
// rather than propagated into the int64 conversions and the running totals,
// where int64(NaN) is implementation-defined and a negative would corrupt the
// aggregate.
func numField(m map[string]any, key string) (float64, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	// Reject non-finite, negative, and implausibly large values. A finite but
	// out-of-range float (e.g. 1e300) would make int64(f) implementation-defined
	// and could overflow the running token totals; an enormous cost_usd could sum
	// to +Inf, which json.Marshal cannot encode (the /api/v1/metrics response
	// would then fail). maxNumericField is far above any real fleet-hour token or
	// cost total yet safely within int64 and float64 summation range.
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > maxNumericField {
		return 0, false
	}
	return f, true
}

// maxNumericField caps an individual telemetry numeric field. 1e15 dwarfs any
// realistic per-window token count or cost while staying well inside int64 and
// leaving headroom to sum costScanLimit events without reaching +Inf.
const maxNumericField = 1e15

func stringField(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}
