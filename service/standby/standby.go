// Package standby keeps a copy of a cluster in another zone.
package standby

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/config"
	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/backup"
	"github.com/housepower/ckman/service/fleet"
	"github.com/housepower/ckman/service/fleetdeploy"
	jsoniter "github.com/json-iterator/go"
	"github.com/pkg/errors"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

// ─── settings ────────────────────────────────────────────────────────────────

func GetSettings() model.FleetSettings {
	s := model.FleetSettings{StandbyIntervalMin: model.DefaultStandbyIntervalMin}
	if raw, err := repository.Ps.GetFleetObject(model.FleetKindSettings, "fleet"); err == nil {
		_ = json.Unmarshal(raw, &s)
	}
	if s.StandbyIntervalMin < model.MinStandbyIntervalMin {
		s.StandbyIntervalMin = model.DefaultStandbyIntervalMin
	}
	return s
}

func SaveSettings(s model.FleetSettings) (model.FleetSettings, error) {
	if s.StandbyIntervalMin < model.MinStandbyIntervalMin || s.StandbyIntervalMin > 24*60 {
		return s, errors.Errorf("sync interval must be %d to 1440 minutes", model.MinStandbyIntervalMin)
	}
	raw, _ := json.Marshal(s)
	return s, repository.Ps.PutFleetObject(model.FleetKindSettings, "fleet", "fleet", raw)
}

// ─── storage of standby records ──────────────────────────────────────────────

var locks sync.Map // primary -> *sync.Mutex

func lock(primary string) *sync.Mutex {
	m, _ := locks.LoadOrStore(primary, &sync.Mutex{})
	return m.(*sync.Mutex)
}

func Get(primary string) (*model.Standby, error) {
	raw, err := repository.Ps.GetFleetObject(model.FleetKindStandby, primary)
	if err != nil {
		return nil, err
	}
	var sb model.Standby
	if err := json.Unmarshal(raw, &sb); err != nil {
		return nil, err
	}
	return &sb, nil
}

func List() ([]*model.Standby, error) {
	raws, err := repository.Ps.ListFleetObjects(model.FleetKindStandby)
	if err != nil {
		return nil, err
	}
	out := make([]*model.Standby, 0, len(raws))
	for _, raw := range raws {
		var sb model.Standby
		if err := json.Unmarshal(raw, &sb); err == nil {
			out = append(out, &sb)
		}
	}
	return out, nil
}

func put(sb *model.Standby) error {
	raw, err := json.Marshal(sb)
	if err != nil {
		return err
	}
	return repository.Ps.PutFleetObject(model.FleetKindStandby, sb.Primary, sb.Primary, raw)
}

func Interval(sb *model.Standby) time.Duration {
	m := sb.IntervalMin
	if m == 0 {
		m = GetSettings().StandbyIntervalMin
	}
	return time.Duration(m) * time.Minute
}

// ─── create ──────────────────────────────────────────────────────────────────

// CreateRequest sets up a standby for Primary.
type CreateRequest struct {
	Primary     string `json:"primary"`
	Mode        string `json:"mode"`
	Zone        string `json:"zone"`
	IntervalMin int    `json:"interval_min"`
	// storage mode
	ConnectionID string                      `json:"connection_id"`
	Bucket       string                      `json:"bucket"`
	Databases    []string                    `json:"databases"`
	Cluster      *fleetdeploy.ClusterRequest `json:"cluster"` // the standby cluster's placement
	// replica mode: one machine ID per primary shard
	Replicas        []string `json:"replicas"`
	AllowOvercommit bool     `json:"allow_overcommit"`
}

// Create validates and starts a standby. Storage mode deploys the standby
// cluster (the returned task); replica mode adds a replica to each shard in
// the background.
func Create(req CreateRequest) (string, error) {
	primary, err := repository.Ps.GetClusterbyName(req.Primary)
	if err != nil {
		return "", errors.Errorf("cluster %s doesn't exist", req.Primary)
	}
	if old, err := Get(req.Primary); err == nil && old != nil {
		return "", errors.Errorf("%s already has a standby", req.Primary)
	}
	if req.IntervalMin != 0 && req.IntervalMin < model.MinStandbyIntervalMin {
		return "", errors.Errorf("sync interval must be at least %d minutes", model.MinStandbyIntervalMin)
	}
	machines, err := fleet.ListMachines()
	if err != nil {
		return "", err
	}
	zoneOf := map[string]string{}
	for _, m := range machines {
		zoneOf[m.ID] = m.Zone
	}
	inZone := func(ids []string) error {
		for _, id := range ids {
			if z, ok := zoneOf[id]; !ok {
				return errors.New("choose a machine for every slot")
			} else if z != req.Zone {
				return errors.Errorf("all standby machines must be in zone %s", req.Zone)
			}
		}
		return nil
	}
	sb := &model.Standby{Primary: req.Primary, Mode: req.Mode, Zone: req.Zone, IntervalMin: req.IntervalMin,
		CreateTime: time.Now(), State: "creating"}

	switch req.Mode {
	case model.StandbyModeStorage:
		if req.Cluster == nil {
			return "", errors.New("place the standby cluster")
		}
		c := *req.Cluster
		if len(c.Shards) != len(primary.Shards) {
			return "", errors.Errorf("the standby needs %d shards, like %s", len(primary.Shards), req.Primary)
		}
		if common.CompareClickHouseVersion(c.Version, primary.Version) < 0 {
			return "", errors.Errorf("the standby's version %s is older than %s's %s", c.Version, req.Primary, primary.Version)
		}
		var ids []string
		for _, s := range c.Shards {
			ids = append(ids, s...)
		}
		if err := inZone(append(ids, c.Keepers...)); err != nil {
			return "", err
		}
		if req.ConnectionID == "" || req.Bucket == "" {
			return "", errors.New("choose a storage connection and bucket")
		}
		if err := backup.CreateConnectionBucket(req.ConnectionID, req.Bucket); err != nil {
			return "", errors.Wrap(err, "bucket")
		}
		taskID, plan, err := fleetdeploy.Create(c)
		if err != nil {
			if len(plan.Errors) > 0 {
				return "", errors.New(strings.Join(plan.Errors, "; "))
			}
			return "", err
		}
		sb.Cluster, sb.ConnectionID, sb.Bucket, sb.Databases = c.Cluster, req.ConnectionID, req.Bucket, req.Databases
		sb.StateMessage = "creating the standby cluster (task " + taskID + ")"
		return taskID, put(sb)

	case model.StandbyModeReplica:
		if primary.Docker == nil {
			return "", errors.New("live-replica standbys need a cluster running on fleet machines")
		}
		if len(req.Replicas) != len(primary.Shards) {
			return "", errors.Errorf("choose one machine for each of the %d shards", len(primary.Shards))
		}
		if err := inZone(req.Replicas); err != nil {
			return "", err
		}
		var ips []string
		for _, id := range req.Replicas {
			m, err := fleet.GetMachine(id)
			if err != nil {
				return "", err
			}
			ips = append(ips, m.IP)
		}
		if err := fleetdeploy.CheckNewNodes(&primary, ips, req.AllowOvercommit); err != nil {
			return "", err
		}
		sb.ReplicaIPs = ips
		sb.StateMessage = "adding standby replicas"
		if err := put(sb); err != nil {
			return "", err
		}
		go addReplicas(req.Primary, ips, req.AllowOvercommit)
		return "", nil
	}
	return "", errors.Errorf("mode must be %q or %q", model.StandbyModeStorage, model.StandbyModeReplica)
}

// addReplicas adds ips[i] to shard i of the primary, one task at a time.
func addReplicas(primary string, ips []string, force bool) {
	fail := func(msg string) {
		mu := lock(primary)
		mu.Lock()
		defer mu.Unlock()
		if sb, err := Get(primary); err == nil {
			sb.State, sb.StateMessage = "failed", msg
			_ = put(sb)
		}
	}
	for i, ip := range ips {
		conf, err := repository.Ps.GetClusterbyName(primary)
		if err != nil {
			fail(err.Error())
			return
		}
		shards := make([]model.CkShard, len(conf.Shards))
		for s := range conf.Shards {
			shards[s].Replicas = append([]model.CkReplica{}, conf.Shards[s].Replicas...)
		}
		already := false
		for _, r := range shards[i].Replicas {
			already = already || r.Ip == ip
		}
		if already {
			continue
		}
		shards[i].Replicas = append(shards[i].Replicas, model.CkReplica{Ip: ip})
		d := deploy.NewCkDeploy(conf)
		d.Conf.Hosts = []string{ip}
		d.Ext.SourceSchemaHost = conf.Shards[i].Replicas[0].Ip
		d.Conf.Shards = shards
		taskID, err := deploy.CreateNewTask(primary, model.TaskTypeCKAddNode, d)
		if err != nil {
			fail(fmt.Sprintf("shard %d: %v", i+1, err))
			return
		}
		if err := waitTask(taskID); err != nil {
			fail(fmt.Sprintf("shard %d: %v", i+1, err))
			return
		}
	}
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	if sb, err := Get(primary); err == nil {
		sb.State, sb.StateMessage = "ready", ""
		_ = put(sb)
	}
	_ = force
}

func waitTask(id string) error {
	for i := 0; i < 1200; i++ {
		t, err := repository.Ps.GetTaskbyTaskId(id)
		if err == nil {
			switch t.Status {
			case model.TaskStatusSuccess:
				return nil
			case model.TaskStatusFailed, model.TaskStatusStopped:
				return errors.Errorf("task %s %s", id, model.TaskStatusMap[t.Status])
			}
		}
		time.Sleep(3 * time.Second)
	}
	return errors.Errorf("task %s didn't finish", id)
}

// ─── actions ─────────────────────────────────────────────────────────────────

// SyncNow runs a sync in the background (storage mode).
func SyncNow(primary string) error {
	sb, err := Get(primary)
	if err != nil {
		return err
	}
	if sb.Mode != model.StandbyModeStorage {
		return errors.New("live-replica standbys replicate continuously")
	}
	if sb.State == "creating" {
		return errors.New("the standby cluster is still being created")
	}
	go runSync(primary)
	return nil
}

func SetPaused(primary string, paused bool) error {
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil {
		return err
	}
	if !sb.PromotedAt.IsZero() {
		return errors.New("the standby was promoted")
	}
	sb.Paused = paused
	return put(sb)
}

// Promote turns the standby into the cluster to use: syncing stops for good.
// With finalSync, one last sync runs first if the primary still answers.
func Promote(primary string, finalSync bool) (string, error) {
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil {
		return "", err
	}
	if !sb.PromotedAt.IsZero() {
		return "", errors.New("already promoted")
	}
	var notes []string
	if sb.Mode == model.StandbyModeStorage {
		// fence first so no write lands on the primary after the final sync
		fence(sb)
		if !sb.Fenced {
			notes = append(notes, sb.Primary+" didn't answer: it is made read-only as soon as it does")
		}
		if finalSync {
			if err := syncOnce(sb); err != nil {
				notes = append(notes, "final sync failed: "+err.Error()+"; the standby has data as of the last successful sync")
			} else {
				sb.LastSuccess = time.Now()
				notes = append(notes, "final sync done")
			}
		}
		if err := setAccess(sb.Cluster, false); err != nil {
			_ = put(sb)
			return "", errors.Wrap(err, "make the standby writable")
		}
	}
	sb.PromotedAt, sb.Paused, sb.State = time.Now(), true, "promoted"
	note := strings.Join(notes, "; ")
	sb.StateMessage = note
	return note, put(sb)
}

// Remove forgets the standby. purge also deletes its backups from the bucket.
// The standby cluster (storage mode) and replicas (replica mode) stay.
func Remove(primary string, purge bool) error {
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil {
		return err
	}
	if purge && sb.Mode == model.StandbyModeStorage {
		if tgt, err := openTarget(sb); err == nil {
			if err := tgt.DeletePrefix("standby/" + sb.Primary + "/"); err != nil {
				return errors.Wrap(err, "delete backups")
			}
		}
	}
	return repository.Ps.DeleteFleetObject(model.FleetKindStandby, primary)
}

// ─── status ──────────────────────────────────────────────────────────────────

type Status struct {
	*model.Standby
	IntervalMin int       `json:"effective_interval_min"`
	NextSync    time.Time `json:"next_sync,omitempty"`
	LagSeconds  int64     `json:"lag_seconds"` // how far behind the standby is (-1 = never synced)
	Overdue     bool      `json:"overdue"`     // lag over twice the interval
	// replica mode
	ReplicaDelay int    `json:"replica_delay_seconds"`
	ReplicaQueue uint64 `json:"replica_queue"`
	ReplicaError string `json:"replica_error,omitempty"`
}

func GetStatus(primary string) (*Status, error) {
	sb, err := Get(primary)
	if err != nil {
		return nil, err
	}
	st := &Status{Standby: sb, IntervalMin: int(Interval(sb) / time.Minute), LagSeconds: -1}
	switch sb.Mode {
	case model.StandbyModeStorage:
		if !sb.LastSuccess.IsZero() {
			st.LagSeconds = int64(time.Since(sb.LastSuccess).Seconds())
			if !sb.Paused && sb.PromotedAt.IsZero() {
				st.Overdue = time.Since(sb.LastSuccess) > 2*Interval(sb)
			}
		}
		if !sb.Paused && sb.PromotedAt.IsZero() && sb.State != "creating" {
			st.NextSync = sb.LastStart.Add(Interval(sb))
		}
	case model.StandbyModeReplica:
		if sb.State != "creating" { // replicas aren't up yet
			replicaStatus(primary, st)
		}
	}
	return st, nil
}

func replicaStatus(primary string, st *Status) {
	conf, err := repository.Ps.GetClusterbyName(primary)
	if err != nil {
		st.ReplicaError = err.Error()
		return
	}
	for _, ip := range st.ReplicaIPs {
		c, err := common.ConnectClickHouse(ip, model.ClickHouseDefaultDB, conf.GetConnOption())
		if err != nil {
			st.ReplicaError = fmt.Sprintf("%s: %v", ip, err)
			continue
		}
		var delay uint64
		var queue uint64
		if err := c.QueryRow("SELECT toUInt64(max(absolute_delay)), toUInt64(sum(queue_size)) FROM system.replicas").Scan(&delay, &queue); err == nil {
			if int(delay) > st.ReplicaDelay {
				st.ReplicaDelay = int(delay)
			}
			st.ReplicaQueue += queue
		}
	}
}

// ─── scheduler ───────────────────────────────────────────────────────────────

var running sync.Map // primary -> struct{}

// runSync syncs one standby unless a sync is already running.
func runSync(primary string) {
	if _, busy := running.LoadOrStore(primary, struct{}{}); busy {
		return
	}
	defer running.Delete(primary)
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil || sb.Mode != model.StandbyModeStorage || !sb.PromotedAt.IsZero() {
		return
	}
	sb.LastStart, sb.State = time.Now(), "syncing"
	_ = put(sb)
	started := sb.LastStart
	err = ensureStandbyAccess(sb)
	if err != nil {
		err = errors.Wrap(err, "make the standby read-only")
	} else {
		err = syncOnce(sb)
	}
	sb.LastEnd = time.Now()
	sb.Syncs++
	if err != nil {
		sb.State, sb.LastError = "failed", err.Error()
		log.Logger.Warnf("[standby] %s -> %s: %v", sb.Primary, sb.Cluster, err)
	} else {
		sb.State, sb.StateMessage, sb.LastError, sb.LastSuccess = "ready", "", "", started
		log.Logger.Infof("[standby] %s -> %s synced %d partitions in %s", sb.Primary, sb.Cluster, sb.LastSynced, sb.LastEnd.Sub(started).Round(time.Second))
	}
	_ = put(sb)
}

// tick starts due syncs and finishes standbys whose cluster was being created.
func tick() {
	if !config.IsMasterNode() {
		return
	}
	all, err := List()
	if err != nil {
		return
	}
	retryFences(all)
	for _, sb := range all {
		if sb.Mode != model.StandbyModeStorage || sb.Paused || !sb.PromotedAt.IsZero() {
			continue
		}
		if sb.State == "creating" {
			if repository.Ps.ClusterExists(sb.Cluster) && !deploy.HasEffectiveTasks(sb.Cluster) {
				go runSync(sb.Primary) // first sync copies everything
			}
			continue
		}
		if time.Since(sb.LastStart) >= Interval(sb) {
			go runSync(sb.Primary)
		}
	}
}

// Start runs the standby scheduler until stop is closed.
func Start(stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				tick()
			}
		}
	}()
}
