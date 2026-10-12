package fleetdeploy

import (
	"fmt"
	"path"
	"strings"

	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/fleet"
	"github.com/pkg/errors"
)

// KeeperChange adds Keepers on machines the user picks and removes others.
// The result must be an odd number of Keepers (Raft needs a majority).
type KeeperChange struct {
	Add             []string `json:"add"`    // machine IDs
	Remove          []string `json:"remove"` // Keeper node IPs
	AllowOvercommit bool     `json:"allow_overcommit"`
}

// ScaleKeepers checks a Keeper change and starts it as a task: Keepers are
// added one at a time, then the ClickHouse servers get the new list, then
// Keepers are removed one at a time (see runner.KeeperScaleHandle).
func ScaleKeepers(cluster string, req KeeperChange) (string, error) {
	conf, err := repository.Ps.GetClusterbyName(cluster)
	if err != nil {
		return "", errors.Errorf("cluster %s doesn't exist", cluster)
	}
	if conf.Docker == nil || !conf.KeeperWithStanalone() {
		return "", errors.New("Keepers can be added or removed on clusters running on fleet machines with their own Keepers")
	}
	kc := *conf.KeeperConf
	kc.KeeperNodes = append([]string{}, kc.KeeperNodes...)
	kc.FillServerIDs()
	member := map[string]bool{}
	for _, h := range kc.KeeperNodes {
		member[h] = true
	}

	var problems []string
	drop := map[string]bool{}
	for _, ip := range req.Remove {
		if !member[ip] {
			problems = append(problems, fmt.Sprintf("%s isn't a Keeper of %s", ip, cluster))
		}
		drop[ip] = true
	}
	var addIPs []string
	seen := map[string]bool{}
	root := strings.TrimRight(conf.Cwd, "/")
	d := conf.Docker
	for _, id := range req.Add {
		m, err := fleet.GetMachine(id)
		if err != nil {
			problems = append(problems, fmt.Sprintf("machine %s: %v", id, err))
			continue
		}
		switch {
		case member[m.IP]:
			problems = append(problems, fmt.Sprintf("%s already runs a Keeper of %s", m.Name, cluster))
			continue
		case seen[m.IP]:
			problems = append(problems, fmt.Sprintf("%s is chosen twice", m.Name))
			continue
		case m.Status != model.MachineStatusReady:
			problems = append(problems, fmt.Sprintf("%s isn't ready (%s)", m.Name, m.Status))
			continue
		}
		seen[m.IP] = true
		if path.Join(m.DataDir, conf.Cluster) != root {
			problems = append(problems, fmt.Sprintf("%s uses data folder %s; this cluster lives in %s", m.Name, m.DataDir, path.Dir(root)))
		}
		if busy := busyPorts(m, []int{d.Ports.KeeperTCP, d.Ports.KeeperRaft}); len(busy) > 0 {
			problems = append(problems, fmt.Sprintf("%s already uses port %s", m.Name, joinInts(busy)))
		}
		if !req.AllowOvercommit {
			st := fleet.Stats(m, true)
			if st.Error != "" {
				problems = append(problems, fmt.Sprintf("%s: can't read usage (%s)", m.Name, st.Error))
			} else if over := overcommit(st, d.KeeperCPU, d.KeeperMemoryMB, d.KeeperDiskGB); over != "" {
				problems = append(problems, fmt.Sprintf("%s would be overcommitted: %s", m.Name, over))
			}
		}
		addIPs = append(addIPs, m.IP)
	}
	final := len(kc.KeeperNodes) - len(drop) + len(addIPs)
	switch {
	case len(drop) == 0 && len(addIPs) == 0 && len(problems) == 0:
		problems = append(problems, "nothing to change")
	case final < 1:
		problems = append(problems, "a cluster needs at least one Keeper")
	case final%2 == 0:
		problems = append(problems, fmt.Sprintf("that leaves %d Keepers: use an odd number (1, 3 or 5) so a majority survives a failure", final))
	}
	if len(problems) > 0 {
		return "", errors.New(strings.Join(problems, "; "))
	}

	next := 0
	for _, id := range kc.ServerIDs {
		if id > next {
			next = id
		}
	}
	want := kc
	want.KeeperNodes, want.ServerIDs = nil, nil
	for i, h := range kc.KeeperNodes {
		if !drop[h] {
			want.KeeperNodes = append(want.KeeperNodes, h)
			want.ServerIDs = append(want.ServerIDs, kc.ServerIDs[i])
		}
	}
	for _, ip := range addIPs {
		next++
		want.KeeperNodes = append(want.KeeperNodes, ip)
		want.ServerIDs = append(want.ServerIDs, next)
	}
	dep := deploy.NewCkDeploy(conf)
	dep.Conf.KeeperConf = &want
	return deploy.CreateNewTask(cluster, model.TaskTypeKeeperScale, dep)
}
