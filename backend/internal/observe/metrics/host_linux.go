//go:build linux

package metrics

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// LinuxHostCollector reads host facts from /proc and statfs on Linux. dataDir is
// the volume whose free space is reported (the daemon's durable state dir).
type LinuxHostCollector struct {
	dataDir string
}

// NewHostCollector returns the Linux host collector.
func NewHostCollector(dataDir string) *LinuxHostCollector {
	return &LinuxHostCollector{dataDir: dataDir}
}

// Host reads loadavg, memory, and disk-free. A failure in one source does not
// abort the others: it returns the partially-filled Host plus the first error,
// which the observer logs and treats as best-effort.
func (c *LinuxHostCollector) Host(_ context.Context) (Host, error) {
	h := Host{NumCPU: runtime.NumCPU()}
	var firstErr error

	if l1, l5, l15, err := readLoadAvg("/proc/loadavg"); err != nil {
		firstErr = err
	} else {
		h.LoadAvg1, h.LoadAvg5, h.LoadAvg15 = l1, l5, l15
	}

	if total, avail, err := readMemInfo("/proc/meminfo"); err != nil {
		if firstErr == nil {
			firstErr = err
		}
	} else {
		h.MemTotalBytes, h.MemAvailableBytes = total, avail
	}

	if total, free, err := readDiskFree(c.dataDir); err != nil {
		if firstErr == nil {
			firstErr = err
		}
	} else {
		h.DiskTotalBytes, h.DiskFreeBytes = total, free
	}

	return h, firstErr
}

func readLoadAvg(path string) (l1, l5, l15 float64, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("loadavg: unexpected format %q", string(data))
	}
	if l1, err = strconv.ParseFloat(fields[0], 64); err != nil {
		return 0, 0, 0, err
	}
	if l5, err = strconv.ParseFloat(fields[1], 64); err != nil {
		return 0, 0, 0, err
	}
	if l15, err = strconv.ParseFloat(fields[2], 64); err != nil {
		return 0, 0, 0, err
	}
	return l1, l5, l15, nil
}

// readMemInfo reads MemTotal and MemAvailable (in bytes) from a meminfo file.
// meminfo reports kB, so values are scaled to bytes.
func readMemInfo(path string) (total, avail uint64, err error) {
	f, err := os.Open(path) //nolint:gosec // fixed /proc path
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	var haveTotal, haveAvail bool
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			if v, ok := parseMemInfoKB(line); ok {
				total = v
				haveTotal = true
			}
		case strings.HasPrefix(line, "MemAvailable:"):
			if v, ok := parseMemInfoKB(line); ok {
				avail = v
				haveAvail = true
			}
		}
		if haveTotal && haveAvail {
			break
		}
	}
	if err := sc.Err(); err != nil {
		return 0, 0, err
	}
	if !haveTotal {
		return 0, 0, fmt.Errorf("meminfo: MemTotal not found")
	}
	return total, avail, nil
}

// parseMemInfoKB parses a "Key:  12345 kB" meminfo line to bytes.
func parseMemInfoKB(line string) (uint64, bool) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0, false
	}
	kb, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return kb * 1024, true
}

// readDiskFree returns total and free bytes on the filesystem holding path.
func readDiskFree(path string) (total, free uint64, err error) {
	if path == "" {
		return 0, 0, fmt.Errorf("disk: empty path")
	}
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize) //nolint:gosec,unconvert // Bsize is platform int; widened to uint64
	total = st.Blocks * bs
	free = st.Bavail * bs
	return total, free, nil
}
