package standby

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/fleet"
	"github.com/pkg/errors"
)

// Lifecycle of a storage-mode standby (record key Primary, standby Cluster):
//
//	normal     Primary takes writes; Cluster is read-only for apps and ckman
//	           syncs it through its own user.
//	promote    Cluster becomes writable. Primary is fenced (made read-only)
//	           now if it answers, otherwise as soon as it does.
//	rejoin     after a promote: the old primary is snapshotted to the bucket
//	           and becomes the standby of the active cluster (record reversed);
//	           the first sync overwrites it.
//	switchover planned swap: Primary goes read-only, a final sync runs,
//	           Cluster becomes writable and the record is reversed.
//
// Scaling the promoted cluster (replicas, Keepers, sizes) stays manual.

const fenceRetry = 2 * time.Minute

func newPassword() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// setAccess makes a cluster's app users read-only or writable and creates
// ckman's sync user the first time. Users config reloads without a restart.
func setAccess(cluster string, readOnly bool) error {
	conf, err := repository.Ps.GetClusterbyName(cluster)
	if err != nil {
		return err
	}
	if conf.Mode == model.CkClusterImport {
		return errors.Errorf("%s is imported: ckman doesn't manage its users", cluster)
	}
	if conf.ReadOnly() == readOnly && conf.Access.SyncUser != "" {
		return checkAccess(conf, readOnly)
	}
	access := model.AccessConf{SyncUser: model.CkfSyncUser, SyncPassword: newPassword()}
	if conf.Access != nil && conf.Access.SyncUser != "" {
		access = *conf.Access
	}
	access.ReadOnly = readOnly
	conf.Access = &access
	d := deploy.NewCkDeploy(conf)
	if err := d.Init(); err != nil {
		return errors.Wrapf(err, "%s: reach the nodes", cluster)
	}
	if err := d.Config(); err != nil {
		return errors.Wrapf(err, "%s: push users config", cluster)
	}
	if err := repository.Ps.UpdateCluster(conf); err != nil {
		return err
	}
	log.Logger.Infof("[standby] %s: apps are now %s", cluster, map[bool]string{true: "read-only", false: "read-write"}[readOnly])
	return checkAccess(conf, readOnly)
}

// checkAccess waits until every node has loaded the users config: the sync
// user logs in and the app user has the expected readonly setting.
func checkAccess(conf model.CKManClickHouseConfig, readOnly bool) error {
	want := 0
	if readOnly {
		want = 2
	}
	app := conf
	app.Access = nil
	var last error
	for try := 0; try < 20; try++ {
		last = nil
		for _, host := range conf.Hosts {
			if _, err := common.ConnectClickHouse(host, model.ClickHouseDefaultDB, conf.GetConnOption()); err != nil {
				last = errors.Wrapf(err, "%s: sync user", host)
				continue
			}
			c, err := common.ConnectClickHouse(host, model.ClickHouseDefaultDB, app.GetConnOption())
			if err != nil {
				last = errors.Wrapf(err, "%s: app user", host)
				continue
			}
			var ro string
			if err := c.QueryRow("SELECT toString(getSetting('readonly'))").Scan(&ro); err != nil {
				last = errors.Wrapf(err, "%s", host)
			} else if ro != fmt.Sprint(want) {
				last = errors.Errorf("%s: apps still have readonly=%s", host, ro)
			}
		}
		if last == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return last
}

// ensureStandbyAccess keeps a standby cluster read-only (also upgrades
// standbys created before read-only existed). Callers hold the lock.
func ensureStandbyAccess(sb *model.Standby) error {
	conf, err := repository.Ps.GetClusterbyName(sb.Cluster)
	if err != nil {
		return err
	}
	if conf.ReadOnly() {
		return nil
	}
	return setAccess(sb.Cluster, true)
}

// fence makes the old primary read-only after a promote. Callers hold the lock.
func fence(sb *model.Standby) {
	sb.FenceTried = time.Now()
	if err := setAccess(sb.Primary, true); err != nil {
		sb.Fenced, sb.FenceError = false, err.Error()
		log.Logger.Warnf("[standby] fence %s: %v (retrying)", sb.Primary, err)
		return
	}
	sb.Fenced, sb.FenceError = true, ""
}

// retryFences fences promoted standbys' old primaries that didn't answer.
func retryFences(all []*model.Standby) {
	for _, sb := range all {
		if sb.PromotedAt.IsZero() || sb.Fenced || sb.Mode != model.StandbyModeStorage || time.Since(sb.FenceTried) < fenceRetry {
			continue
		}
		go func(primary string) {
			mu := lock(primary)
			mu.Lock()
			defer mu.Unlock()
			if sb, err := Get(primary); err == nil && !sb.PromotedAt.IsZero() && !sb.Fenced {
				fence(sb)
				_ = put(sb)
			}
		}(sb.Primary)
	}
}

// promoteStorage makes the standby cluster writable and fences the primary.
func promoteStorage(sb *model.Standby) error {
	if err := setAccess(sb.Cluster, false); err != nil {
		return errors.Wrap(err, "make the standby writable")
	}
	fence(sb)
	return nil
}

// reversed is the record after the roles swap: the active cluster is the new
// primary, the other one its standby. Sync state starts over.
func reversed(sb *model.Standby, now time.Time) *model.Standby {
	nb := &model.Standby{
		Primary: sb.Cluster, Cluster: sb.Primary, Mode: sb.Mode, Zone: zoneOf(sb.Primary, sb.Zone),
		ConnectionID: sb.ConnectionID, Bucket: sb.Bucket, IntervalMin: sb.IntervalMin, Databases: sb.Databases,
		CreateTime: now, State: "ready", Previous: sb.Primary, ReversedAt: now,
	}
	return nb
}

// zoneOf is the zone of a cluster's machines, or def.
func zoneOf(cluster, def string) string {
	conf, err := repository.Ps.GetClusterbyName(cluster)
	if err != nil || len(conf.Hosts) == 0 {
		return def
	}
	machines, err := fleet.ListMachines()
	if err != nil {
		return def
	}
	for _, m := range machines {
		if m.IP == conf.Hosts[0] && m.Zone != "" {
			return m.Zone
		}
	}
	return def
}

// swapRecord stores the reversed record under the new primary's name.
func swapRecord(old, nb *model.Standby) error {
	if other, err := Get(nb.Primary); err == nil && other != nil {
		return errors.Errorf("%s already has a standby record", nb.Primary)
	}
	if err := put(nb); err != nil {
		return err
	}
	return repository.Ps.DeleteFleetObject(model.FleetKindStandby, old.Primary)
}

// Rejoin turns the old primary of a promoted standby into the standby of the
// active cluster. The old primary must answer; it is fenced, snapshotted to
// the bucket and then overwritten by the first sync.
func Rejoin(primary string) (string, error) {
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil {
		return "", err
	}
	if sb.Mode != model.StandbyModeStorage {
		return "", errors.New("only storage-sync standbys can rejoin")
	}
	if sb.PromotedAt.IsZero() {
		return "", errors.New("the standby wasn't promoted: use switch over")
	}
	if !sb.Fenced {
		fence(sb)
		_ = put(sb)
		if !sb.Fenced {
			return "", errors.Errorf("%s can't be made read-only yet: %s", sb.Primary, sb.FenceError)
		}
	}
	key, err := snapshot(sb)
	if err != nil {
		return "", errors.Wrap(err, "safety snapshot")
	}
	nb := reversed(sb, time.Now())
	nb.Snapshot = key
	nb.StateMessage = "rejoined: the first sync overwrites " + sb.Primary + " (snapshot " + key + ")"
	if err := swapRecord(sb, nb); err != nil {
		return "", err
	}
	go runSync(nb.Primary)
	return key, nil
}

// snapshot backs up every synced database of the old primary, shard by
// shard, to standby/<old primary>/snapshot-<time>/ in the bucket.
func snapshot(sb *model.Standby) (string, error) {
	conf, err := repository.Ps.GetClusterbyName(sb.Primary)
	if err != nil {
		return "", err
	}
	tgt, err := openTarget(sb)
	if err != nil {
		return "", err
	}
	conns, err := shardConns(conf)
	if err != nil {
		return "", err
	}
	tables, err := listTables(conns[0], sb.Databases)
	if err != nil {
		return "", err
	}
	dbs := map[string]bool{}
	for _, t := range tables {
		dbs[t.db] = true
	}
	key := path.Join("standby", sb.Primary, "snapshot-"+time.Now().UTC().Format("20060102T150405"))
	if len(dbs) == 0 {
		return key + " (empty)", nil
	}
	var items []string
	for db := range dbs {
		items = append(items, "DATABASE `"+db+"`")
	}
	for i, c := range conns {
		q := fmt.Sprintf("BACKUP %s TO %s", strings.Join(items, ", "), tgt.Dest(path.Join(key, fmt.Sprintf("shard%d", i+1))))
		if err := c.Exec(q); err != nil {
			return "", errors.Wrapf(err, "shard %d", i+1)
		}
	}
	return key, nil
}

// Switchover swaps the roles of a healthy pair: the primary stops taking
// writes, a final sync copies everything, the standby becomes writable and
// the record is reversed. A failed final sync gives the primary its writes
// back and changes nothing else.
func Switchover(primary string) error {
	mu := lock(primary)
	mu.Lock()
	defer mu.Unlock()
	sb, err := Get(primary)
	if err != nil {
		return err
	}
	if sb.Mode != model.StandbyModeStorage {
		return errors.New("only storage-sync standbys can switch over")
	}
	if !sb.PromotedAt.IsZero() {
		return errors.New("the standby was promoted: rejoin the old primary instead")
	}
	if sb.State == "creating" {
		return errors.New("the standby cluster is still being created")
	}
	if _, busy := running.LoadOrStore(primary, struct{}{}); busy {
		return errors.New("a sync is running: try again when it ends")
	}
	defer running.Delete(primary)
	if err := ensureStandbyAccess(sb); err != nil {
		return errors.Wrap(err, "standby access")
	}
	if err := setAccess(sb.Primary, true); err != nil {
		_ = setAccess(sb.Primary, false)
		return errors.Wrap(err, "make the primary read-only")
	}
	sb.LastStart = time.Now()
	if err := syncOnce(sb); err != nil {
		_ = put(sb)
		if rerr := setAccess(sb.Primary, false); rerr != nil {
			return errors.Errorf("final sync failed (%v) and %s is still read-only: %v", err, sb.Primary, rerr)
		}
		return errors.Wrap(err, "final sync failed; nothing changed")
	}
	if err := setAccess(sb.Cluster, false); err != nil {
		_ = setAccess(sb.Primary, false)
		return errors.Wrap(err, "make the standby writable; the primary takes writes again")
	}
	now := time.Now()
	nb := reversed(sb, now)
	nb.LastStart, nb.LastEnd, nb.LastSuccess = now, now, now
	nb.StateMessage = "switched over from " + sb.Primary
	if err := seedState(nb); err != nil {
		log.Logger.Warnf("[standby] %s: seed sync state: %v (the next sync copies everything)", nb.Primary, err)
		nb.Tables = nil
	}
	return swapRecord(sb, nb)
}

// seedState records the new primary's current partitions as already synced:
// after the final sync both sides hold the same data, so the next sync only
// copies what changes from now on.
func seedState(nb *model.Standby) error {
	conf, err := repository.Ps.GetClusterbyName(nb.Primary)
	if err != nil {
		return err
	}
	conns, err := shardConns(conf)
	if err != nil {
		return err
	}
	tables, err := listTables(conns[0], nb.Databases)
	if err != nil {
		return err
	}
	nb.Tables = map[string]*model.StandbyTable{}
	nb.TableUUIDs = map[string]string{}
	for _, t := range tables {
		if t.uuid != "" && t.uuid != zeroUUID {
			nb.TableUUIDs[t.uuid] = t.key()
		}
		if !t.data() {
			continue
		}
		st := &model.StandbyTable{Shards: map[int]map[string]string{}, LastKey: map[int]string{}}
		for i, c := range conns {
			fp, rows, err := fingerprints(c, t.db, t.name)
			if err != nil {
				return err
			}
			st.Shards[i] = fp
			st.PrimaryRows += rows
		}
		st.StandbyRows = st.PrimaryRows
		nb.Tables[t.key()] = st
	}
	return nil
}
