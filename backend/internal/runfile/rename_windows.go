//go:build windows

package runfile

import (
	"syscall"
	"unsafe"
)

// movefileReplaceExisting tells MoveFileEx to overwrite dst if it already
// exists. Mirrors MOVEFILE_REPLACE_EXISTING from the Win32 API; declared
// locally so we don't pull in golang.org/x/sys for a single constant.
const movefileReplaceExisting = 0x1

var moveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// atomicReplace renames src to dst, replacing dst if it exists. Go's
// os.Rename on Windows happens to do the same MoveFileEx call internally,
// but calling it directly makes the cross-platform contract explicit instead
// of leaning on a runtime implementation detail. The replace is atomic
// against concurrent readers — readers see either the old or the new file,
// never an empty or partially-written one.
func atomicReplace(src, dst string) error {
	srcPtr, err := syscall.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	dstPtr, err := syscall.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	ret, _, err := moveFileExW.Call(
		uintptr(unsafe.Pointer(srcPtr)),
		uintptr(unsafe.Pointer(dstPtr)),
		uintptr(movefileReplaceExisting),
	)
	if ret == 0 {
		return err
	}
	return nil
}
