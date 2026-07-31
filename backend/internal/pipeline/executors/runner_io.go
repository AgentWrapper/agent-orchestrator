package executors

import (
	"io"
	"sync"
)

// capBuffer is an io.Writer that captures up to limit bytes and drops the rest,
// recording whether the cap fired. Safe for concurrent writes (one pump
// goroutine per stream, but a shared lock keeps it robust).
type capBuffer struct {
	mu     sync.Mutex
	limit  int
	buf    []byte
	capped bool
}

func (b *capBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.buf)
	if remaining <= 0 {
		b.capped = true
		return len(p), nil
	}
	if len(p) > remaining {
		b.buf = append(b.buf, p[:remaining]...)
		b.capped = true
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *capBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// teeSink returns a writer that fans output into the capturing buffer and, when
// a sink is present, forwards each chunk to it tagged with the stream name.
func teeSink(buf *capBuffer, sink LogSink, stream string) io.Writer {
	if sink == nil {
		return buf
	}
	return io.MultiWriter(buf, sinkWriter{sink: sink, stream: stream})
}

// sinkWriter adapts a LogSink to io.Writer for one named stream.
type sinkWriter struct {
	sink   LogSink
	stream string
}

func (w sinkWriter) Write(p []byte) (int, error) {
	// Copy: the caller may reuse the buffer after Write returns, and the sink
	// might retain the slice.
	chunk := make([]byte, len(p))
	copy(chunk, p)
	w.sink.Write(w.stream, chunk)
	return len(p), nil
}
