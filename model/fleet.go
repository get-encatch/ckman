package model

import "time"

// Fleet: machines (VMs reached over SSH, running Docker) that host ClickHouse
// and Keeper instances as containers.

const (
	FleetKindMachine = "machine"

	MachineStatusReady       = "ready"
	MachineStatusNoDocker    = "no_docker"
	MachineStatusUnreachable = "unreachable"

	FleetDefaultDataDir = "/var/lib/ckfleet"
)

type Machine struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	IP               string            `json:"ip"`
	Zone             string            `json:"zone"`
	Labels           map[string]string `json:"labels"`
	SshUser          string            `json:"ssh_user"`
	SshPort          int               `json:"ssh_port"`
	AuthenticateType int               `json:"authenticate_type"`      // SshPasswordSave or SshPasswordUsePubkey
	SshPassword      string            `json:"ssh_password,omitempty"` // encrypted at rest, never returned
	DataDir          string            `json:"data_dir"`               // instance data lives under it
	Facts            MachineFacts      `json:"facts"`
	Status           string            `json:"status"`
	StatusMessage    string            `json:"status_message,omitempty"`
	CreateTime       time.Time         `json:"create_time"`
	UpdateTime       time.Time         `json:"update_time"`
}

// MachineFacts is what the last check found on the machine.
type MachineFacts struct {
	Hostname      string    `json:"hostname"`
	OS            string    `json:"os"`
	Arch          string    `json:"arch"`
	Cores         int       `json:"cores"`
	MemTotal      uint64    `json:"mem_total"`
	DiskTotal     uint64    `json:"disk_total"` // volume holding DataDir
	DockerVersion string    `json:"docker_version"`
	CheckedAt     time.Time `json:"checked_at"`
}

// MachineStats is live usage: the machine, what its containers reserve
// (their limits) and what each container uses.
type MachineStats struct {
	MachineID    string           `json:"machine_id"`
	Cores        int              `json:"cores"`
	Load1        float64          `json:"load1"`
	CPUUsed      float64          `json:"cpu_used"` // busy cores, sampled over one second
	MemUsed      uint64           `json:"mem_used"`
	MemTotal     uint64           `json:"mem_total"`
	DiskUsed     uint64           `json:"disk_used"`
	DiskTotal    uint64           `json:"disk_total"`
	ReservedCPU  float64          `json:"reserved_cpu"`  // sum of container CPU limits
	ReservedMem  uint64           `json:"reserved_mem"`  // sum of container memory limits
	ReservedDisk uint64           `json:"reserved_disk"` // sum of container disk (soft) limits
	Containers   []ContainerStats `json:"containers"`
	CollectedAt  time.Time        `json:"collected_at"`
	Error        string           `json:"error,omitempty"`
}

// ContainerStats is one ckman-managed container (label ckfleet.managed=1).
type ContainerStats struct {
	Name       string  `json:"name"`
	Cluster    string  `json:"cluster"`
	Role       string  `json:"role"` // clickhouse | keeper
	Image      string  `json:"image"`
	State      string  `json:"state"`
	CPUPercent float64 `json:"cpu_percent"` // of one core, like docker stats
	CPULimit   float64 `json:"cpu_limit"`   // cores, 0 = unlimited
	MemUsed    uint64  `json:"mem_used"`
	MemLimit   uint64  `json:"mem_limit"` // 0 = unlimited
	DiskUsed   uint64  `json:"disk_used"`
	DiskLimit  uint64  `json:"disk_limit"` // soft limit, 0 = none
	Dir        string  `json:"dir"`
}
