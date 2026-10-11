package deploy

import (
	"strings"
	"testing"

	"github.com/housepower/ckman/model"
)

func dockerConf() *model.CKManClickHouseConfig {
	return &model.CKManClickHouseConfig{
		Cluster: "c1",
		Version: "26.9.15.5",
		Cwd:     "/var/lib/ckfleet/c1/",
		PkgType: "amd64.docker",
		Docker: &model.DockerConf{
			Image: "clickhouse/clickhouse-server", KeeperImage: "clickhouse/clickhouse-keeper",
			CPU: 1.5, MemoryMB: 2048, DiskGB: 10, KeeperCPU: 0.5, KeeperMemoryMB: 256, KeeperDiskGB: 2,
		},
	}
}

func TestRunCmdClickHouse(t *testing.T) {
	cmd := runCmd(dockerConf(), spec(dockerConf(), roleClickHouse))
	for _, want := range []string{
		"--name ckf-c1-clickhouse", "--network host", "--restart unless-stopped",
		"--cpus 1.5", "--memory 2048m --memory-swap 2048m",
		"-v /var/lib/ckfleet/c1:/var/lib/ckfleet/c1",
		"-v /var/lib/ckfleet/c1/etc/clickhouse-server/config.d:/etc/clickhouse-server/config.d",
		"-v /var/lib/ckfleet/c1/etc/clickhouse-server/users.d:/etc/clickhouse-server/users.d",
		"-e CLICKHOUSE_SKIP_USER_SETUP=1",
		"--label ckfleet.managed=1", "--label ckfleet.cluster=c1", "--label ckfleet.role=clickhouse",
		"--label ckfleet.dir=/var/lib/ckfleet/c1/clickhouse", "--label ckfleet.disk_limit=10737418240",
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("docker run is missing %q:\n%s", want, cmd)
		}
	}
	if !strings.HasSuffix(cmd, " clickhouse/clickhouse-server:26.9.15.5") {
		t.Errorf("image should come last: %s", cmd)
	}
}

func TestRunCmdKeeperNoLimits(t *testing.T) {
	conf := dockerConf()
	conf.Docker.KeeperCPU, conf.Docker.KeeperMemoryMB, conf.Docker.KeeperDiskGB = 0, 0, 0
	cmd := runCmd(conf, spec(conf, roleKeeper))
	if strings.Contains(cmd, "--cpus") || strings.Contains(cmd, "--memory") || strings.Contains(cmd, "disk_limit") {
		t.Errorf("no limits set, none expected: %s", cmd)
	}
	for _, want := range []string{"--name ckf-c1-keeper", "-v /var/lib/ckfleet/c1/etc/clickhouse-keeper:/etc/clickhouse-keeper",
		"--label ckfleet.role=keeper", "clickhouse/clickhouse-keeper:26.9.15.5"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("missing %q: %s", want, cmd)
		}
	}
	if strings.Contains(cmd, "CLICKHOUSE_SKIP_USER_SETUP") {
		t.Errorf("the keeper image has no user setup: %s", cmd)
	}
}

func TestPortsForSlot(t *testing.T) {
	p := model.PortsForSlot(2)
	if p.TCP != 20040 || p.HTTP != 20041 || p.Interserver != 20042 || p.KeeperTCP != 20050 || p.KeeperRaft != 20051 {
		t.Errorf("unexpected block for slot 2: %+v", p)
	}
	seen := map[int]bool{}
	for slot := 0; slot < 3; slot++ {
		for _, port := range model.PortsForSlot(slot).All() {
			if seen[port] {
				t.Fatalf("port %d appears in two blocks", port)
			}
			seen[port] = true
		}
	}
}
