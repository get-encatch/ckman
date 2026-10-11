package model

import "strings"

// Docker mode: ClickHouse and Keeper run as containers on fleet machines.
// Each cluster owns a block of ports (PortSlot) so several clusters share a
// machine on host networking; a machine runs at most one ClickHouse and one
// Keeper container per cluster.

const (
	PkgSuffixDocker = "docker"

	DefaultClickHouseImage = "clickhouse/clickhouse-server"
	DefaultKeeperImage     = "clickhouse/clickhouse-keeper"

	dockerPortBase  = 20000
	dockerPortBlock = 20
)

type DockerConf struct {
	Image          string      `json:"image"`        // clickhouse/clickhouse-server
	KeeperImage    string      `json:"keeper_image"` // clickhouse/clickhouse-keeper
	CPU            float64     `json:"cpu"`          // cores per ClickHouse instance, 0 = no limit
	MemoryMB       int         `json:"memory_mb"`
	DiskGB         int         `json:"disk_gb"` // soft limit: shown and warned, not enforced
	KeeperCPU      float64     `json:"keeper_cpu"`
	KeeperMemoryMB int         `json:"keeper_memory_mb"`
	KeeperDiskGB   int         `json:"keeper_disk_gb"`
	PortSlot       int         `json:"port_slot"`
	Ports          DockerPorts `json:"ports"`
}

type DockerPorts struct {
	TCP         int `json:"tcp"`
	HTTP        int `json:"http"`
	Interserver int `json:"interserver"`
	Prometheus  int `json:"prometheus"`
	KeeperTCP   int `json:"keeper_tcp"`
	KeeperRaft  int `json:"keeper_raft"`
}

// PortsForSlot is the port block of a cluster: 20000 + 20*slot onwards.
func PortsForSlot(slot int) DockerPorts {
	base := dockerPortBase + dockerPortBlock*slot
	return DockerPorts{
		TCP: base, HTTP: base + 1, Interserver: base + 2, Prometheus: base + 3,
		KeeperTCP: base + 10, KeeperRaft: base + 11,
	}
}

func (p DockerPorts) All() []int {
	return []int{p.TCP, p.HTTP, p.Interserver, p.Prometheus, p.KeeperTCP, p.KeeperRaft}
}

func (config *CKManClickHouseConfig) IsDocker() bool {
	return config.Docker != nil || strings.HasSuffix(config.PkgType, "."+PkgSuffixDocker)
}

// ContainerName is the container of a cluster role ("clickhouse" or "keeper").
func ContainerName(cluster, role string) string {
	return "ckf-" + cluster + "-" + role
}
