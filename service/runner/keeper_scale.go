package runner

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/zookeeper"
	"github.com/pkg/errors"
)

// KeeperScaleHandle moves a cluster's Keepers to the list in the task
// (d.Conf.KeeperConf, with stable server IDs), one member at a time so a
// majority always agrees:
//
//  1. each new Keeper starts with the larger member list, then the existing
//     Keepers get that list; Keeper applies the change on config reload and
//     the new node copies the data from the leader;
//  2. the ClickHouse servers get the new Keeper list (reloaded live);
//  3. each removed Keeper is dropped from the others' list (it hands off
//     leadership first if it leads), then its container is removed.
//
// The cluster record is saved after every step, so a failed task leaves it
// matching what runs.
func KeeperScaleHandle(ctx context.Context, task *model.Task) error {
	var d deploy.CKDeploy
	if err := UnmarshalConfig(task.DeployConfig, &d); err != nil {
		return err
	}
	conf, err := repository.Ps.GetClusterbyName(d.Conf.Cluster)
	if err != nil {
		return err
	}
	want := *d.Conf.KeeperConf
	cur := *conf.KeeperConf
	cur.KeeperNodes = append([]string{}, cur.KeeperNodes...)
	cur.FillServerIDs()
	inWant, inCur := map[string]int{}, map[string]bool{}
	for i, h := range want.KeeperNodes {
		inWant[h] = want.ServerID(i)
	}
	for _, h := range cur.KeeperNodes {
		inCur[h] = true
	}
	save := func(kc model.KeeperConf) error {
		conf.KeeperConf = &kc
		return repository.Ps.UpdateCluster(conf)
	}
	withKeepers := func(kc model.KeeperConf) model.CKManClickHouseConfig {
		c := conf
		c.KeeperConf = &kc
		return c
	}

	for _, host := range want.KeeperNodes {
		if inCur[host] {
			continue
		}
		if err := checkCancel(ctx); err != nil {
			return err
		}
		step := cur
		step.KeeperNodes = append(append([]string{}, cur.KeeperNodes...), host)
		step.ServerIDs = append(append([]int{}, cur.ServerIDs...), inWant[host])
		sc := withKeepers(step)

		deploy.SetNodeStatus(task, model.NodeStatusInstall, host)
		kd := deploy.NewKeeperDeploy(sc, d.Packages)
		kd.Only = []string{host}
		// a joining Keeper only opens its client port once it is a member,
		// so it is checked by waitQuorum after the others accept it
		for _, f := range []func() error{kd.Init, kd.Prepare, kd.Install, kd.Config, kd.Start} {
			if err := f(); err != nil {
				_ = kd.Uninstall()
				return errors.Wrapf(err, "start Keeper on %s", host)
			}
		}
		deploy.SetNodeStatus(task, model.NodeStatusConfig, host)
		members := deploy.NewKeeperDeploy(sc, d.Packages)
		members.Only = cur.KeeperNodes
		if err := members.Init(); err != nil {
			_ = kd.Uninstall()
			return err
		}
		joinErr := members.Config()
		if joinErr == nil {
			joinErr = waitQuorum(step, 3*time.Minute)
		}
		if joinErr != nil {
			// a member that never joined would cost the majority: put the
			// old list back before removing the new Keeper
			back := deploy.NewKeeperDeploy(withKeepers(cur), d.Packages)
			back.Only = cur.KeeperNodes
			if err := back.Init(); err == nil {
				_ = back.Config()
			}
			_ = waitQuorum(cur, time.Minute)
			_ = kd.Stop()
			_ = kd.Uninstall()
			return errors.Wrapf(joinErr, "%s didn't join; the Keepers are back to %d", host, len(cur.KeeperNodes))
		}
		if err := save(step); err != nil {
			return err
		}
		cur = step
		deploy.SetNodeStatus(task, model.NodeStatusDone, host)
		log.Logger.Infof("[keepers] %s: %s joined as server %d", conf.Cluster, host, inWant[host])
	}

	// ClickHouse servers use only the Keepers that stay
	keep := cur
	keep.KeeperNodes, keep.ServerIDs = nil, nil
	var removed []string
	for i, h := range cur.KeeperNodes {
		if _, ok := inWant[h]; ok {
			keep.KeeperNodes = append(keep.KeeperNodes, h)
			keep.ServerIDs = append(keep.ServerIDs, cur.ServerIDs[i])
		} else {
			removed = append(removed, h)
		}
	}
	deploy.SetNodeStatus(task, model.NodeStatusConfig, model.ALL_NODES_DEFAULT)
	ckd := deploy.NewCkDeploy(withKeepers(keep))
	if err := ckd.Init(); err != nil {
		return err
	}
	if err := ckd.Config(); err != nil {
		return errors.Wrap(err, "give the ClickHouse servers the new Keeper list")
	}

	for _, host := range removed {
		if err := checkCancel(ctx); err != nil {
			return err
		}
		step := cur
		step.KeeperNodes, step.ServerIDs = nil, nil
		for i, h := range cur.KeeperNodes {
			if h != host {
				step.KeeperNodes = append(step.KeeperNodes, h)
				step.ServerIDs = append(step.ServerIDs, cur.ServerIDs[i])
			}
		}
		sc := withKeepers(step)
		deploy.SetNodeStatus(task, model.NodeStatusConfig, host)
		if state(host, cur.TcpPort) == "leader" {
			_, _ = zookeeper.ZkMetric(host, cur.TcpPort, "ydld") // yield leadership
			if err := waitNewLeader(step, 30*time.Second); err != nil {
				return errors.Wrapf(err, "%s leads and didn't hand over", host)
			}
		}
		members := deploy.NewKeeperDeploy(sc, d.Packages)
		members.Only = step.KeeperNodes
		if err := members.Init(); err != nil {
			return err
		}
		if err := members.Config(); err != nil {
			return errors.Wrap(err, "give the Keepers the new member list")
		}
		if err := waitQuorum(step, 3*time.Minute); err != nil {
			return errors.Wrapf(err, "removing %s", host)
		}
		deploy.SetNodeStatus(task, model.NodeStatusUninstall, host)
		gone := deploy.NewKeeperDeploy(sc, d.Packages)
		gone.Only = []string{host}
		_ = gone.Stop()
		if err := gone.Uninstall(); err != nil {
			log.Logger.Warnf("[keepers] %s: remove the Keeper container on %s: %v", conf.Cluster, host, err)
		}
		if err := save(step); err != nil {
			return err
		}
		cur = step
		deploy.SetNodeStatus(task, model.NodeStatusDone, host)
		log.Logger.Infof("[keepers] %s: %s left", conf.Cluster, host)
	}
	deploy.SetNodeStatus(task, model.NodeStatusDone, model.ALL_NODES_DEFAULT)
	return nil
}

// mntr reads a Keeper's mntr; ZkMetric returns it as JSON without the
// "zk_" prefixes.
func mntr(host string, port int) map[string]interface{} {
	out, err := zookeeper.ZkMetric(host, port, "mntr")
	if err != nil {
		return nil
	}
	m := map[string]interface{}{}
	if json.Unmarshal(out, &m) != nil {
		return nil
	}
	return m
}

func state(host string, port int) string {
	s, _ := mntr(host, port)["server_state"].(string)
	return s
}

// waitQuorum waits until the Keepers agree on exactly kc's members: one
// leader (or a standalone node) whose synced followers are all the others.
func waitQuorum(kc model.KeeperConf, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	last := "no answer"
	for time.Now().Before(deadline) {
		leaders, synced, ok := 0, -1, true
		for _, h := range kc.KeeperNodes {
			m := mntr(h, kc.TcpPort)
			switch m["server_state"] {
			case "leader":
				leaders++
				n, _ := m["synced_followers"].(float64)
				synced = int(n)
			case "standalone":
				leaders++
				synced = 0
			case "follower":
			default:
				ok, last = false, h+" isn't serving yet"
			}
		}
		if ok {
			if leaders == 1 && synced == len(kc.KeeperNodes)-1 {
				return nil
			}
			last = "leader has " + strconv.Itoa(synced) + " synced followers, want " + strconv.Itoa(len(kc.KeeperNodes)-1)
		}
		time.Sleep(2 * time.Second)
	}
	return errors.New(last)
}

func waitNewLeader(kc model.KeeperConf, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, h := range kc.KeeperNodes {
			if s := state(h, kc.TcpPort); s == "leader" || s == "standalone" {
				return nil
			}
		}
		time.Sleep(time.Second)
	}
	return errors.New("no other Keeper became leader")
}
