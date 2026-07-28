package preview

import (
	"hash/fnv"
	"io/fs"
	"path/filepath"
	"strconv"
)

// staticTreeSignature fingerprints the files served from the selected entry's
// directory. A preview rooted at dist/index.html watches dist/**, while a root
// index.html watches the workspace tree. Framework dev-server URLs never reach
// this path; their own HMR remains authoritative.
func staticTreeSignature(entry Entry) uint64 {
	root := filepath.Dir(entry.AbsPath)
	hash := fnv.New64a()
	seen := 0
	_ = filepath.WalkDir(root, func(filePath string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			//nolint:nilerr // unreadable preview assets do not invalidate the rest of the tree
			return nil
		}
		if item.IsDir() {
			if filePath != root && skipPreviewDir(item.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !item.Type().IsRegular() {
			return nil
		}
		seen++
		if seen > maxPreviewWalkFiles {
			return filepath.SkipAll
		}
		info, err := item.Info()
		if err != nil {
			//nolint:nilerr // a concurrently replaced file will be observed on the next poll
			return nil
		}
		rel, err := filepath.Rel(root, filePath)
		if err != nil {
			//nolint:nilerr // skip this path while keeping the rest of the preview live
			return nil
		}
		writeSignatureField(hash, filepath.ToSlash(rel))
		writeSignatureField(hash, strconv.FormatInt(info.ModTime().UnixNano(), 10))
		writeSignatureField(hash, strconv.FormatInt(info.Size(), 10))
		return nil
	})
	return hash.Sum64()
}

type signatureWriter interface {
	Write([]byte) (int, error)
}

func writeSignatureField(hash signatureWriter, value string) {
	_, _ = hash.Write([]byte(value))
	_, _ = hash.Write([]byte{0})
}
