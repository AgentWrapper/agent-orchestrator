//go:build windows

package usage

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func sourceFileID(file *os.File) (string, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"windows:%08x:%08x%08x",
		info.VolumeSerialNumber,
		info.FileIndexHigh,
		info.FileIndexLow,
	), nil
}
