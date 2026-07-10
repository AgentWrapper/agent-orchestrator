package mobilebridge

import (
	"net"
	"strings"
)

func skipInterface(i net.Interface) bool {
	if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
		return true
	}
	n := strings.ToLower(i.Name)
	for _, bad := range []string{"utun", "tun", "tap", "docker", "bridge", "vmnet", "llw", "awdl"} {
		if strings.HasPrefix(n, bad) {
			return true
		}
	}
	return false
}

// PrivateIPv4Candidates returns the private IPv4 addresses of the given
// interfaces, skipping down/loopback/virtual interfaces (see skipInterface) and
// non-private, loopback, or link-local addresses. addrsOf is injected so callers
// (and tests) can supply the per-interface address lookup.
func PrivateIPv4Candidates(ifaces []net.Interface, addrsOf func(net.Interface) ([]net.Addr, error)) []string {
	var out []string
	for _, i := range ifaces {
		if skipInterface(i) {
			continue
		}
		addrs, err := addrsOf(i)
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			ip4 := ip.To4()
			if ip4 == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip4.IsPrivate() {
				out = append(out, ip4.String())
			}
		}
	}
	return out
}

// AutopickLANIP returns the first private IPv4 address of a suitable local
// interface, or "" if none is found. It is a best-effort convenience for
// surfacing the LAN address the phone should connect to.
func AutopickLANIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	c := PrivateIPv4Candidates(ifaces, func(i net.Interface) ([]net.Addr, error) {
		return i.Addrs()
	})
	if len(c) == 0 {
		return ""
	}
	return c[0]
}
