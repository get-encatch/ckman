// Package fleetdeploy turns a placement on fleet machines into a ckman
// cluster deploy (Docker mode). It sits above both the fleet registry and the
// deploy package, which can't import each other.
package fleetdeploy

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/fleet"
	"github.com/pkg/errors"
)

// ClusterRequest places a new cluster on fleet machines. Shards[i][j] is the
// machine ID of replica j of shard i; Keepers are machine IDs (1, 3 or 5).
type ClusterRequest struct {
	Cluster         string     `json:"cluster"`
	Comment         string     `json:"comment"`
	Version         string     `json:"version"`
	Shards          [][]string `json:"shards"`
	Keepers         []string   `json:"keepers"`
	CPU             float64    `json:"cpu"`
	MemoryMB        int        `json:"memory_mb"`
	DiskGB          int        `json:"disk_gb"`
	KeeperCPU       float64    `json:"keeper_cpu"`
	KeeperMemoryMB  int        `json:"keeper_memory_mb"`
	KeeperDiskGB    int        `json:"keeper_disk_gb"`
	Password        string     `json:"password"`
	AllowOvercommit bool       `json:"allow_overcommit"`
}

// Plan is the checked placement: blocking errors, warnings to confirm, the
// ports the cluster gets and what each machine reserves afterwards.
type Plan struct {
	Errors   []string          `json:"errors"`
	Warnings []string          `json:"warnings"`
	PortSlot int               `json:"port_slot"`
	Ports    model.DockerPorts `json:"ports"`
	Machines []PlanMachine     `json:"machines"`
}

type PlanMachine struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Zone      string   `json:"zone"`
	Roles     []string `json:"roles"` // e.g. "shard 1 replica 2", "keeper"
	CPU       float64  `json:"cpu"`   // reserved after this cluster
	CPUTotal  float64  `json:"cpu_total"`
	Mem       uint64   `json:"mem"`
	MemTotal  uint64   `json:"mem_total"`
	Disk      uint64   `json:"disk"`
	DiskTotal uint64   `json:"disk_total"`
}

var clusterNameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,62}$`)

type placed struct {
	m     model.Machine
	roles []string
	ch    bool
	keep  bool
}

// MakePlan checks a request without deploying anything.
func MakePlan(req ClusterRequest) (Plan, map[string]*placed) {
	p := Plan{Errors: []string{}, Warnings: []string{}, Machines: []PlanMachine{}}
	fail := func(f string, a ...any) { p.Errors = append(p.Errors, fmt.Sprintf(f, a...)) }
	warn := func(f string, a ...any) { p.Warnings = append(p.Warnings, fmt.Sprintf(f, a...)) }

	if !clusterNameRe.MatchString(req.Cluster) {
		fail("Cluster name: start with a letter; letters, digits and '_' only")
	} else if repository.Ps.ClusterExists(req.Cluster) {
		fail("A cluster named %s already exists", req.Cluster)
	}
	if req.Version == "" {
		fail("Choose a ClickHouse version")
	}
	if req.Password == "" {
		fail("Set a password for the default user")
	}
	if len(req.Shards) == 0 {
		fail("Add at least one shard")
	}
	if n := len(req.Keepers); n != 1 && n != 3 && n != 5 {
		fail("Keeper needs 1, 3 or 5 servers (an odd number keeps a majority)")
	}

	all, err := fleet.ListMachines()
	if err != nil {
		fail("Can't read machines: %v", err)
		return p, nil
	}
	byID := map[string]model.Machine{}
	zones := map[string]bool{}
	for _, m := range all {
		byID[m.ID] = m
		if m.Zone != "" {
			zones[m.Zone] = true
		}
	}
	use := map[string]*placed{}
	get := func(id, role string) *placed {
		m, ok := byID[id]
		if !ok {
			fail("%s: no machine chosen", role)
			return nil
		}
		if m.Status != model.MachineStatusReady {
			fail("%s: %s isn't ready (%s)", role, m.Name, m.Status)
		}
		u := use[id]
		if u == nil {
			u = &placed{m: m}
			use[id] = u
		}
		u.roles = append(u.roles, role)
		return u
	}

	for i, shard := range req.Shards {
		if len(shard) == 0 {
			fail("Shard %d has no replicas", i+1)
		}
		shardZones := map[string]int{}
		for j, id := range shard {
			role := fmt.Sprintf("shard %d replica %d", i+1, j+1)
			u := get(id, role)
			if u == nil {
				continue
			}
			if u.ch {
				fail("%s runs two ClickHouse instances of this cluster (%s): each instance needs its own machine", u.m.Name, strings.Join(u.roles, ", "))
			}
			u.ch = true
			shardZones[u.m.Zone]++
		}
		if len(shard) > 1 && len(zones) > 1 {
			for z, n := range shardZones {
				if n > 1 {
					warn("Shard %d has %d replicas in zone %s: losing that zone loses the shard", i+1, n, zoneName(z))
				}
			}
		}
	}
	keeperZones := map[string]int{}
	for k, id := range req.Keepers {
		u := get(id, fmt.Sprintf("keeper %d", k+1))
		if u == nil {
			continue
		}
		if u.keep {
			fail("%s is chosen for two Keepers: losing it would break the Keeper majority", u.m.Name)
		}
		u.keep = true
		keeperZones[u.m.Zone]++
		if u.ch {
			warn("Keeper shares %s with ClickHouse: fine for small setups; production prefers dedicated Keeper machines", u.m.Name)
		}
	}
	if len(req.Keepers) == 1 {
		warn("A single Keeper has no fault tolerance: if it stops, replicated tables become read-only")
	}
	if len(req.Keepers) > 1 && len(zones) > 1 {
		for z, n := range keeperZones {
			if n*2 > len(req.Keepers) {
				warn("%d of %d Keepers are in zone %s: losing that zone stops Keeper", n, len(req.Keepers), zoneName(z))
			}
		}
	}

	// one data folder, SSH login and CPU type for the whole cluster
	var first *placed
	for _, u := range use {
		if first == nil {
			first = u
			continue
		}
		if u.m.DataDir != first.m.DataDir {
			fail("All machines of a cluster need the same data folder (%s uses %s, %s uses %s)", first.m.Name, first.m.DataDir, u.m.Name, u.m.DataDir)
		}
		if u.m.SshUser != first.m.SshUser || u.m.SshPort != first.m.SshPort || u.m.AuthenticateType != first.m.AuthenticateType {
			fail("All machines of a cluster need the same SSH login (%s and %s differ)", first.m.Name, u.m.Name)
		}
		if u.m.Facts.Arch != first.m.Facts.Arch {
			fail("Machines have different CPU types (%s: %s, %s: %s)", first.m.Name, first.m.Facts.Arch, u.m.Name, u.m.Facts.Arch)
		}
	}

	if req.MemoryMB > 0 && req.MemoryMB < 1024 {
		warn("ClickHouse with less than 1 GiB of memory fails on bigger queries and merges")
	}
	if req.KeeperMemoryMB > 0 && req.KeeperMemoryMB < 256 {
		warn("Keeper with less than 256 MiB of memory may be killed under load")
	}

	slot, slotErr := freePortSlot()
	if slotErr != nil {
		fail("%v", slotErr)
	}
	p.PortSlot, p.Ports = slot, model.PortsForSlot(slot)

	// capacity and ports, from live machine stats
	ids := make([]string, 0, len(use))
	for id := range use {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return use[ids[i]].m.Name < use[ids[j]].m.Name })
	type live struct {
		st   model.MachineStats
		busy []int
	}
	lives := make([]live, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			full, ok := fleet.MachineByIP(use[id].m.IP)
			if !ok {
				return
			}
			lives[i].st = fleet.Stats(full, true)
			lives[i].busy = busyPorts(full, p.Ports.All())
		}(i, id)
	}
	wg.Wait()
	for i, id := range ids {
		u, l := use[id], lives[i]
		if l.st.Error != "" {
			fail("%s: can't read usage (%s)", u.m.Name, l.st.Error)
			continue
		}
		pm := PlanMachine{ID: id, Name: u.m.Name, Zone: u.m.Zone, Roles: u.roles,
			CPU: l.st.ReservedCPU, CPUTotal: float64(l.st.Cores), Mem: l.st.ReservedMem, MemTotal: l.st.MemTotal,
			Disk: l.st.ReservedDisk, DiskTotal: l.st.DiskTotal}
		if u.ch {
			pm.CPU += req.CPU
			pm.Mem += uint64(req.MemoryMB) << 20
			pm.Disk += uint64(req.DiskGB) << 30
		}
		if u.keep {
			pm.CPU += req.KeeperCPU
			pm.Mem += uint64(req.KeeperMemoryMB) << 20
			pm.Disk += uint64(req.KeeperDiskGB) << 30
		}
		p.Machines = append(p.Machines, pm)
		over := []string{}
		if pm.CPU > pm.CPUTotal {
			over = append(over, fmt.Sprintf("CPU %.1f of %.0f cores", pm.CPU, pm.CPUTotal))
		}
		if pm.Mem > pm.MemTotal {
			over = append(over, fmt.Sprintf("memory %s of %s", fleet.HumanBytes(pm.Mem), fleet.HumanBytes(pm.MemTotal)))
		}
		if pm.Disk > pm.DiskTotal {
			over = append(over, fmt.Sprintf("disk %s of %s", fleet.HumanBytes(pm.Disk), fleet.HumanBytes(pm.DiskTotal)))
		}
		if len(over) > 0 {
			msg := fmt.Sprintf("%s would be overcommitted: %s reserved", u.m.Name, strings.Join(over, ", "))
			if req.AllowOvercommit {
				warn("%s", msg)
			} else {
				fail("%s (allow overcommit to deploy anyway)", msg)
			}
		}
		if len(l.busy) > 0 {
			fail("%s already uses port %s", u.m.Name, joinInts(l.busy))
		}
	}

	if req.Version != "" {
		if ok, err := fleet.ImageVersionExists(model.DefaultClickHouseImage, req.Version); err != nil {
			warn("Couldn't check version %s on Docker Hub: %v", req.Version, err)
		} else if !ok {
			fail("Docker Hub has no %s:%s", model.DefaultClickHouseImage, req.Version)
		}
	}
	return p, use
}

// Create checks the plan and starts the deploy task. It returns the task ID,
// or the plan when it has errors.
func Create(req ClusterRequest) (string, Plan, error) {
	p, use := MakePlan(req)
	if len(p.Errors) > 0 {
		return "", p, errors.New(strings.Join(p.Errors, "; "))
	}
	conf, err := buildConfig(req, p, use)
	if err != nil {
		return "", p, err
	}
	d := deploy.NewCkDeploy(conf)
	taskID, err := deploy.CreateNewTask(conf.Cluster, model.TaskTypeCKDeploy, d)
	return taskID, p, err
}

func buildConfig(req ClusterRequest, p Plan, use map[string]*placed) (model.CKManClickHouseConfig, error) {
	var any0 model.Machine
	for _, u := range use {
		any0 = u.m
		break
	}
	full, ok := fleet.MachineByIP(any0.IP) // with its SSH password
	if !ok {
		return model.CKManClickHouseConfig{}, errors.Errorf("machine %s disappeared", any0.Name)
	}
	root := path.Join(full.DataDir, req.Cluster) + "/"
	arch := "amd64"
	if full.Facts.Arch == "aarch64" || full.Facts.Arch == "arm64" {
		arch = "arm64"
	}
	ip := func(id string) string { return use[id].m.IP }

	conf := model.CKManClickHouseConfig{
		Cluster:          req.Cluster,
		Comment:          req.Comment,
		PkgType:          arch + "." + model.PkgSuffixDocker,
		PkgName:          model.DefaultClickHouseImage + ":" + req.Version,
		Version:          req.Version,
		Cwd:              root,
		Path:             root,
		Protocol:         "native",
		Port:             p.Ports.TCP,
		HttpPort:         p.Ports.HTTP,
		User:             model.ClickHouseDefaultUser,
		Password:         req.Password,
		IsReplica:        true,
		Mode:             model.CkClusterDeploy,
		SshUser:          full.SshUser,
		SshPort:          full.SshPort,
		AuthenticateType: full.AuthenticateType,
		SshPassword:      full.SshPassword,
		Keeper:           model.ClickhouseKeeper,
		KeeperConf: &model.KeeperConf{
			Runtime:  model.KeeperRuntimeStandalone,
			TcpPort:  p.Ports.KeeperTCP,
			RaftPort: p.Ports.KeeperRaft,
			Path:     root,
		},
		Docker: &model.DockerConf{
			Image: model.DefaultClickHouseImage, KeeperImage: model.DefaultKeeperImage,
			CPU: req.CPU, MemoryMB: req.MemoryMB, DiskGB: req.DiskGB,
			KeeperCPU: req.KeeperCPU, KeeperMemoryMB: req.KeeperMemoryMB, KeeperDiskGB: req.KeeperDiskGB,
			PortSlot: p.PortSlot, Ports: p.Ports,
		},
	}
	for _, shard := range req.Shards {
		var s model.CkShard
		for _, id := range shard {
			s.Replicas = append(s.Replicas, model.CkReplica{Ip: ip(id)})
			conf.Hosts = append(conf.Hosts, ip(id))
		}
		conf.Shards = append(conf.Shards, s)
	}
	for _, id := range req.Keepers {
		conf.KeeperConf.KeeperNodes = append(conf.KeeperConf.KeeperNodes, ip(id))
	}
	conf.Normalize()
	conf.NeedSudo = false
	return conf, nil
}

// freePortSlot is the lowest port block no Docker cluster uses.
func freePortSlot() (int, error) {
	clusters, err := repository.Ps.GetAllClusters()
	if err != nil {
		return 0, errors.Wrap(err, "list clusters")
	}
	used := map[int]bool{}
	for _, c := range clusters {
		if c.Docker != nil {
			used[c.Docker.PortSlot] = true
		}
	}
	for slot := 0; slot < 2000; slot++ {
		if !used[slot] {
			return slot, nil
		}
	}
	return 0, errors.New("no free port block left")
}

// busyPorts returns which of the ports something already listens on.
func busyPorts(m model.Machine, ports []int) []int {
	out, err := fleet.Run(m, "ss -Hltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u")
	if err != nil {
		return nil
	}
	listening := map[string]bool{}
	for _, l := range strings.Fields(out) {
		listening[l] = true
	}
	var busy []int
	for _, p := range ports {
		if listening[fmt.Sprint(p)] {
			busy = append(busy, p)
		}
	}
	return busy
}

func joinInts(v []int) string {
	s := make([]string, len(v))
	for i, n := range v {
		s[i] = fmt.Sprint(n)
	}
	return strings.Join(s, ", ")
}

func zoneName(z string) string {
	return common.GetStringwithDefault(z, "(none)")
}
