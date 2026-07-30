package preview

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStaticTreeSignatureCoversFilesBeyondEntryDiscoveryLimit(t *testing.T) {
	root := t.TempDir()
	entryPath := filepath.Join(root, "index.html")
	writeFile(t, entryPath, "<main>preview</main>")
	assets := filepath.Join(root, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	for i := 0; i <= maxPreviewWalkFiles; i++ {
		writeFile(t, filepath.Join(assets, fmt.Sprintf("%05d.css", i)), "a")
	}
	latePath := filepath.Join(assets, fmt.Sprintf("%05d.css", maxPreviewWalkFiles))
	entry, ok := EntryAtPath(root, "index.html")
	if !ok {
		t.Fatal("entry not found")
	}
	before := staticTreeSignature(entry)

	writeFile(t, latePath, "changed after the old cutoff")
	mod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(latePath, mod, mod); err != nil {
		t.Fatalf("chtimes late asset: %v", err)
	}
	after := staticTreeSignature(entry)
	if before == after {
		t.Fatal("signature ignored an asset beyond the entry-discovery limit")
	}
}
