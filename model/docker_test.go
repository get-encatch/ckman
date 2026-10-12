package model

import "testing"

func TestDockerSizes(t *testing.T) {
	d := DockerConf{CPU: 2, MemoryMB: 4096, DiskGB: 100, KeeperCPU: 0.5, KeeperMemoryMB: 512, KeeperDiskGB: 10}
	if got := d.ServerSize("10.0.0.1"); got != (Size{2, 4096, 100}) {
		t.Fatalf("default: %+v", got)
	}
	d.SetServerSize("10.0.0.1", Size{MemoryMB: 8192}) // only memory differs
	if got := d.ServerSize("10.0.0.1"); got != (Size{2, 8192, 100}) {
		t.Fatalf("override: %+v", got)
	}
	if got := d.ServerSize("10.0.0.2"); got != (Size{2, 4096, 100}) {
		t.Fatalf("other host: %+v", got)
	}
	d.SetServerSize("10.0.0.1", Size{2, 4096, 100}) // back to the default
	if len(d.ServerSizes) != 0 {
		t.Fatalf("default size kept as an override: %v", d.ServerSizes)
	}
	d.SetKeeperSize("10.0.0.3", Size{CPU: 1})
	if got := d.KeeperSize("10.0.0.3"); got != (Size{1, 512, 10}) {
		t.Fatalf("keeper: %+v", got)
	}
}
