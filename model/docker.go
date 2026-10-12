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
	// Per-instance sizes by host IP; a zero field falls back to the cluster
	// defaults above (one ClickHouse and one Keeper per cluster per machine).
	ServerSizes map[string]Size `json:"server_sizes,omitempty"`
	KeeperSizes map[string]Size `json:"keeper_sizes,omitempty"`
}

// Size is the limits of one container. Disk is a soft limit.
type Size struct {
	CPU      float64 `json:"cpu"`
	MemoryMB int     `json:"memory_mb"`
	DiskGB   int     `json:"disk_gb"`
}

func (s Size) IsZero() bool { return s.CPU == 0 && s.MemoryMB == 0 && s.DiskGB == 0 }

// Or fills s's zero fields from def.
func (s Size) Or(def Size) Size {
	if s.CPU == 0 {
		s.CPU = def.CPU
	}
	if s.MemoryMB == 0 {
		s.MemoryMB = def.MemoryMB
	}
	if s.DiskGB == 0 {
		s.DiskGB = def.DiskGB
	}
	return s
}

func (d *DockerConf) ServerDefault() Size { return Size{d.CPU, d.MemoryMB, d.DiskGB} }
func (d *DockerConf) KeeperDefault() Size {
	return Size{d.KeeperCPU, d.KeeperMemoryMB, d.KeeperDiskGB}
}

// ServerSize is the size of the ClickHouse container on host.
func (d *DockerConf) ServerSize(host string) Size {
	return d.ServerSizes[host].Or(d.ServerDefault())
}

// KeeperSize is the size of the Keeper container on host.
func (d *DockerConf) KeeperSize(host string) Size {
	return d.KeeperSizes[host].Or(d.KeeperDefault())
}

// SetServerSize stores host's size; the default size removes the override.
func (d *DockerConf) SetServerSize(host string, s Size) {
	d.ServerSizes = setSize(d.ServerSizes, host, s, d.ServerDefault())
}

func (d *DockerConf) SetKeeperSize(host string, s Size) {
	d.KeeperSizes = setSize(d.KeeperSizes, host, s, d.KeeperDefault())
}

func setSize(m map[string]Size, host string, s, def Size) map[string]Size {
	s = s.Or(def)
	if s == def || s.IsZero() {
		delete(m, host)
		return m
	}
	if m == nil {
		m = map[string]Size{}
	}
	m[host] = s
	return m
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
