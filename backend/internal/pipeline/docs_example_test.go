package pipeline

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// docsPath is the user-facing pipelines doc, relative to this package.
const docsPath = "../../../docs/pipelines.md"

// docsValidatedMarker precedes every YAML block in the doc that is meant to be
// a whole, valid pipeline definition. Fragments (a lone `concurrency:` block,
// say) are deliberately not marked and are not checked here.
const docsValidatedMarker = "<!-- validated -->"

// The worked example in docs/pipelines.md, checked against the real parser and
// the real validator.
//
// The doc is the only user-facing description of the feature, and its previous
// version stayed on the page for a whole rewrite describing a system that had
// been deleted. An example nobody runs is the same failure in miniature: it
// reads fine right up until someone pastes it into the editor. ParseDefinition
// plus Validate is the exact path POST /pipelines/validate takes, so a doc
// example that would be rejected in the editor is rejected here first.
//
// Warnings are asserted empty too, not just errors: an example that saves but
// lights up the problems panel is a bad example.
func TestDocsExampleValidates(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(docsPath))
	if err != nil {
		t.Fatalf("read %s: %v", docsPath, err)
	}

	blocks := markedYAMLBlocks(string(raw))
	if len(blocks) == 0 {
		t.Fatalf("no %s yaml block found in %s", docsValidatedMarker, docsPath)
	}

	for i, src := range blocks {
		p, warnings, err := ParseDefinitionWithWarnings([]byte(src))
		if err != nil {
			t.Errorf("docs example %d does not validate:\n%v\n\n%s", i, err, src)
			continue
		}
		if len(warnings) > 0 {
			t.Errorf("docs example %d (%s) warns: %+v", i, p.Name, warnings)
		}
	}
}

// markedYAMLBlocks returns the body of every fenced yaml block preceded by the
// validated marker. Anything else in the document is left alone.
func markedYAMLBlocks(doc string) []string {
	lines := strings.Split(doc, "\n")
	var blocks []string
	marked := false
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		switch {
		case line == docsValidatedMarker:
			marked = true
		case line == "```yaml" && marked:
			marked = false
			var body []string
			for i++; i < len(lines) && strings.TrimSpace(lines[i]) != "```"; i++ {
				body = append(body, lines[i])
			}
			blocks = append(blocks, strings.Join(body, "\n"))
		case line != "":
			// Any other content between the marker and a fence means the marker
			// was not labelling a yaml block after all.
			marked = false
		}
	}
	return blocks
}
