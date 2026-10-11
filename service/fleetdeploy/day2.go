package fleetdeploy

import (
	"fmt"
	"path"
	"strings"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/fleet"
	"github.com/pkg/errors"
)

// CheckNewNodes validates machines being added to a Docker cluster: they
// must be ready fleet machines with the cluster's data folder, free ports
// and (unless force) room for the cluster's instance size.
func CheckNewNodes(conf *model.CKManClickHouseConfig, ips []string, force bool) error {
	root := strings.TrimRight(conf.Cwd, "/")
	var problems []string
	for _, ip := range ips {
		m, ok := fleet.MachineByIP(ip)
		if !ok {
			problems = append(problems, fmt.Sprintf("%s isn't a machine in the fleet; add it on the Machines page first", ip))
			continue
		}
		if m.Status != model.MachineStatusReady {
			problems = append(problems, fmt.Sprintf("%s isn't ready (%s)", m.Name, m.Status))
			continue
		}
		if path.Join(m.DataDir, conf.Cluster) != root {
			problems = append(problems, fmt.Sprintf("%s uses data folder %s; this cluster lives in %s", m.Name, m.DataDir, path.Dir(root)))
		}
		d := conf.Docker
		ports := []int{d.Ports.TCP, d.Ports.HTTP, d.Ports.Interserver, d.Ports.Prometheus}
		if busy := busyPorts(m, ports); len(busy) > 0 {
			problems = append(problems, fmt.Sprintf("%s already uses port %s", m.Name, joinInts(busy)))
		}
		if !force {
			st := fleet.Stats(m, true)
			if st.Error != "" {
				problems = append(problems, fmt.Sprintf("%s: can't read usage (%s)", m.Name, st.Error))
				continue
			}
			if over := overcommit(st, d.CPU, d.MemoryMB, d.DiskGB); over != "" {
				problems = append(problems, fmt.Sprintf("%s would be overcommitted: %s (add with force to allow)", m.Name, over))
			}
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func overcommit(st model.MachineStats, cpu float64, memMB, diskGB int) string {
	var over []string
	if c := st.ReservedCPU + cpu; c > float64(st.Cores) {
		over = append(over, fmt.Sprintf("CPU %.1f of %d cores", c, st.Cores))
	}
	if m := st.ReservedMem + uint64(memMB)<<20; m > st.MemTotal {
		over = append(over, fmt.Sprintf("memory %s of %s", fleet.HumanBytes(m), fleet.HumanBytes(st.MemTotal)))
	}
	if d := st.ReservedDisk + uint64(diskGB)<<30; d > st.DiskTotal {
		over = append(over, fmt.Sprintf("disk %s of %s", fleet.HumanBytes(d), fleet.HumanBytes(st.DiskTotal)))
	}
	return strings.Join(over, ", ")
}

// Resources are the per-instance limits of a Docker cluster.
type Resources struct {
	CPU             float64 `json:"cpu"`
	MemoryMB        int     `json:"memory_mb"`
	DiskGB          int     `json:"disk_gb"`
	KeeperCPU       float64 `json:"keeper_cpu"`
	KeeperMemoryMB  int     `json:"keeper_memory_mb"`
	KeeperDiskGB    int     `json:"keeper_disk_gb"`
	AllowOvercommit bool    `json:"allow_overcommit"`
}

// Resize changes the limits of a Docker cluster's containers live (docker
// update: no restart). Disk is a soft limit read from the cluster, so it
// changes immediately too.
func Resize(cluster string, r Resources) ([]string, error) {
	conf, err := repository.Ps.GetClusterbyName(cluster)
	if err != nil {
		return nil, err
	}
	if conf.Docker == nil {
		return nil, errors.Errorf("%s doesn't run on fleet machines", cluster)
	}
	if r.MemoryMB > 0 && r.MemoryMB < 512 || r.KeeperMemoryMB > 0 && r.KeeperMemoryMB < 128 {
		return nil, errors.New("memory too small: ClickHouse needs at least 512 MiB, Keeper 128 MiB")
	}
	old := *conf.Docker
	type change struct {
		ip, role   string
		cpu        float64
		memMB      int
		dCPU, dMem float64
		dDisk      float64
	}
	var changes []change
	for _, ip := range conf.Hosts {
		changes = append(changes, change{ip: ip, role: "clickhouse", cpu: r.CPU, memMB: r.MemoryMB,
			dCPU: r.CPU - old.CPU, dMem: float64(r.MemoryMB - old.MemoryMB), dDisk: float64(r.DiskGB - old.DiskGB)})
	}
	if conf.KeeperConf != nil {
		for _, ip := range conf.KeeperConf.KeeperNodes {
			changes = append(changes, change{ip: ip, role: "keeper", cpu: r.KeeperCPU, memMB: r.KeeperMemoryMB,
				dCPU: r.KeeperCPU - old.KeeperCPU, dMem: float64(r.KeeperMemoryMB - old.KeeperMemoryMB), dDisk: float64(r.KeeperDiskGB - old.KeeperDiskGB)})
		}
	}
	// capacity: per machine, the increase over today's reservation
	if !r.AllowOvercommit {
		grow := map[string][3]float64{}
		for _, c := range changes {
			g := grow[c.ip]
			g[0] += c.dCPU
			g[1] += c.dMem
			g[2] += c.dDisk
			grow[c.ip] = g
		}
		var problems []string
		for ip, g := range grow {
			m, ok := fleet.MachineByIP(ip)
			if !ok {
				continue
			}
			st := fleet.Stats(m, true)
			if over := overcommit(st, g[0], int(g[1]), int(g[2])); over != "" && (g[0] > 0 || g[1] > 0 || g[2] > 0) {
				problems = append(problems, fmt.Sprintf("%s would be overcommitted: %s", m.Name, over))
			}
		}
		if len(problems) > 0 {
			return nil, errors.New(strings.Join(problems, "; ") + " (allow overcommit to resize anyway)")
		}
	}
	var done []string
	for _, c := range changes {
		m, ok := fleet.MachineByIP(c.ip)
		if !ok {
			return done, errors.Errorf("%s isn't a fleet machine", c.ip)
		}
		args := []string{}
		if c.cpu > 0 {
			args = append(args, fmt.Sprintf("--cpus %g", c.cpu))
		} else {
			args = append(args, "--cpus 0")
		}
		if c.memMB > 0 {
			// raising memory: swap limit first (it must stay >= memory); lowering: memory first
			args = append(args, fmt.Sprintf("--memory %dm --memory-swap %dm", c.memMB, c.memMB))
		}
		name := model.ContainerName(cluster, c.role)
		if _, err := fleet.Run(m, fmt.Sprintf("docker update %s %s >/dev/null", strings.Join(args, " "), name)); err != nil {
			return done, errors.Wrapf(err, "resize %s on %s", c.role, m.Name)
		}
		done = append(done, fmt.Sprintf("%s on %s", c.role, m.Name))
	}
	conf.Docker.CPU, conf.Docker.MemoryMB, conf.Docker.DiskGB = r.CPU, r.MemoryMB, r.DiskGB
	conf.Docker.KeeperCPU, conf.Docker.KeeperMemoryMB, conf.Docker.KeeperDiskGB = r.KeeperCPU, r.KeeperMemoryMB, r.KeeperDiskGB
	if err := repository.Ps.UpdateCluster(conf); err != nil {
		return done, err
	}
	for _, ip := range append(append([]string{}, conf.Hosts...), conf.KeeperConf.KeeperNodes...) {
		if m, ok := fleet.MachineByIP(ip); ok {
			fleet.Stats(m, true)
		}
	}
	_ = common.Pool
	return done, nil
}
