package sessionmanager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWriteSpawnAttachments(t *testing.T) {
	dir := t.TempDir()
	refs, err := writeSpawnAttachments(dir, []ports.SpawnAttachment{
		{Ext: ".png", Data: []byte("first")},
		{Ext: ".jpg", Data: []byte("second")},
		{Ext: "", Data: []byte("third")},
	})
	if err != nil {
		t.Fatalf("writeSpawnAttachments: %v", err)
	}

	want := []string{".ao/attachments/image-1.png", ".ao/attachments/image-2.jpg", ".ao/attachments/image-3.bin"}
	if len(refs) != len(want) {
		t.Fatalf("refs = %v, want %v", refs, want)
	}
	for i, ref := range refs {
		if ref != want[i] {
			t.Errorf("ref[%d] = %q, want %q", i, ref, want[i])
		}
		got, readErr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(ref)))
		if readErr != nil {
			t.Fatalf("read %s: %v", ref, readErr)
		}
		if len(got) == 0 {
			t.Errorf("attachment %s is empty on disk", ref)
		}
	}
}

func TestAppendAttachmentReferences(t *testing.T) {
	t.Run("appends after a brief", func(t *testing.T) {
		got := appendAttachmentReferences("Fix the button", []string{".ao/attachments/image-1.png"})
		if !strings.HasPrefix(got, "Fix the button\n\n") {
			t.Errorf("brief not preserved: %q", got)
		}
		if !strings.Contains(got, "- .ao/attachments/image-1.png") {
			t.Errorf("missing reference: %q", got)
		}
	})

	t.Run("handles empty brief", func(t *testing.T) {
		got := appendAttachmentReferences("", []string{".ao/attachments/image-1.png"})
		if strings.HasPrefix(got, "\n") {
			t.Errorf("leading blank line for empty brief: %q", got)
		}
		if !strings.Contains(got, "Attached images") {
			t.Errorf("missing header: %q", got)
		}
	})

	t.Run("no refs returns prompt unchanged", func(t *testing.T) {
		if got := appendAttachmentReferences("brief", nil); got != "brief" {
			t.Errorf("got %q, want %q", got, "brief")
		}
	})
}
