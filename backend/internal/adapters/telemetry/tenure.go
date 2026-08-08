package telemetry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// How long has this install been around, and how many days has it actually been
// used? PostHog's retention insight answers "of the installs first seen in week
// N, how many came back", which is a cohort question. It cannot answer "of the
// installs active today, how long have they been with us", because that is a
// property of the install rather than of a cohort.
//
// Stamping tenure on every event makes the second question a one-property
// breakdown: a single chart showing how much of today's activity comes from
// people on their first day versus their sixth month.

const tenureStateFile = "telemetry_tenure.json"

// TenureBucket is a closed vocabulary, so it can be charted directly without a
// numeric axis and without exposing an exact install date.
type TenureBucket string

// The buckets, coarsening as tenure grows: a first-day install and a
// second-day install are different stories, whereas month seven and month eight
// are not.
const (
	TenureFirstDay   TenureBucket = "d0"
	TenureFirstWeek  TenureBucket = "d1_6"
	TenureFirstMonth TenureBucket = "w1_4"
	TenureQuarter    TenureBucket = "m1_2"
	TenureHalfYear   TenureBucket = "m3_5"
	TenureVeteran    TenureBucket = "m6_plus"
)

func tenureBucketFor(ageDays int) TenureBucket {
	switch {
	case ageDays <= 0:
		return TenureFirstDay
	case ageDays < 7:
		return TenureFirstWeek
	case ageDays < 30:
		return TenureFirstMonth
	case ageDays < 90:
		return TenureQuarter
	case ageDays < 180:
		return TenureHalfYear
	default:
		return TenureVeteran
	}
}

type tenureState struct {
	FirstSeen string `json:"first_seen"`
	// LastActive plus ActiveDays is what keeps this bounded. Storing every active
	// date would grow without limit on a long-lived install; a counter plus the
	// last date is enough to increment once per calendar day.
	LastActive string `json:"last_active"`
	ActiveDays int    `json:"active_days"`
}

// tenureTracker records how long an install has existed and how many distinct
// days it has been seen. Safe for concurrent use: the sink emits from any
// goroutine.
type tenureTracker struct {
	path string
	now  func() time.Time

	mu    sync.Mutex
	state tenureState
}

func newTenureTracker(dataDir string, now func() time.Time) *tenureTracker {
	if now == nil {
		now = time.Now
	}
	t := &tenureTracker{now: now}
	if dataDir != "" {
		t.path = filepath.Join(dataDir, tenureStateFile)
	}
	t.load()
	return t
}

func (t *tenureTracker) load() {
	if t.path == "" {
		return
	}
	b, err := os.ReadFile(t.path)
	if err != nil {
		return
	}
	var st tenureState
	if err := json.Unmarshal(b, &st); err != nil {
		return
	}
	t.state = st
}

func (t *tenureTracker) saveLocked() {
	if t.path == "" {
		return
	}
	body, err := json.Marshal(t.state)
	if err != nil {
		return
	}
	// Best effort by design: losing tenure is preferable to failing an event.
	_ = os.WriteFile(t.path, append(body, '\n'), 0o600)
}

// observe records that the install was seen now, and returns its tenure. The
// first call on a fresh install reports age 0 and one active day, so a brand new
// install is never indistinguishable from one with no record.
func (t *tenureTracker) observe() (ageDays, activeDays int, bucket TenureBucket) {
	now := t.now().UTC()
	today := now.Format("2006-01-02")

	t.mu.Lock()
	defer t.mu.Unlock()

	dirty := false
	if t.state.FirstSeen == "" {
		t.state.FirstSeen = today
		dirty = true
	}
	if t.state.LastActive != today {
		t.state.LastActive = today
		t.state.ActiveDays++
		dirty = true
	}
	if dirty {
		t.saveLocked()
	}

	first, err := time.Parse("2006-01-02", t.state.FirstSeen)
	if err != nil {
		// A corrupt date must not poison the numbers with something nonsensical.
		return 0, t.state.ActiveDays, TenureFirstDay
	}
	age := int(now.Truncate(24*time.Hour).Sub(first.UTC()).Hours() / 24)
	if age < 0 {
		// Clock moved backwards, or the file came from another machine. Clamp
		// rather than report a negative age.
		age = 0
	}
	return age, t.state.ActiveDays, tenureBucketFor(age)
}

func (t *tenureTracker) String() string {
	age, active, bucket := t.observe()
	return fmt.Sprintf("age=%dd active=%dd bucket=%s", age, active, bucket)
}
