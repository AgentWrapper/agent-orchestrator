package httpd

import (
	"testing"
	"time"
)

func TestCLITelemetryReservoirPersistsDailyReservations(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 20, 10, 0, 0, 0, time.UTC)

	first := newCLITelemetryReservoir(dir)
	if !first.reserveActive(now) {
		t.Fatal("first active reservation = false, want true")
	}
	if !first.reserveInvoked(now, "ao status") {
		t.Fatal("first invoked reservation = false, want true")
	}

	second := newCLITelemetryReservoir(dir)
	if second.reserveActive(now) {
		t.Fatal("active reservation after reload = true, want false")
	}
	if second.reserveInvoked(now, "ao status") {
		t.Fatal("invoked reservation after reload = true, want false")
	}
	if !second.reserveInvoked(now, "ao session ls") {
		t.Fatal("new command reservation after reload = false, want true")
	}
}

func TestCLITelemetryReservoirResetsOnNewUTCDay(t *testing.T) {
	dir := t.TempDir()
	firstDay := time.Date(2026, 7, 20, 23, 59, 0, 0, time.UTC)
	secondDay := time.Date(2026, 7, 21, 0, 1, 0, 0, time.UTC)

	r := newCLITelemetryReservoir(dir)
	if !r.reserveActive(firstDay) || !r.reserveInvoked(firstDay, "ao status") {
		t.Fatal("initial reservations failed")
	}
	if !r.reserveActive(secondDay) {
		t.Fatal("active reservation on new UTC day = false, want true")
	}
	if !r.reserveInvoked(secondDay, "ao status") {
		t.Fatal("invoked reservation on new UTC day = false, want true")
	}
}
