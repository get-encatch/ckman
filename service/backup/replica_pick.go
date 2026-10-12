package backup

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/fleet"
	"github.com/pkg/errors"
)

// Which replica of each shard a backup reads. Per run and per table:
//   - reachable and not read-only (a replica that lost Keeper may be stale);
//   - a table that isn't replicated: the replica holding the most rows of it,
//     since the other replicas don't have them;
//   - then a replica in the cluster's preferred backup zone, if one is set,
//     to keep the load off the servers apps use;
//   - then the least replication delay, then the fewest running queries.

type candidate struct {
	host       string
	conn       *common.Conn
	pos        int
	replicated bool
	readonly   bool
	delay      uint64
	rows       uint64
	busy       uint64
	inZone     bool
}

func quoteLit(s string) string { return "'" + strings.ReplaceAll(s, "'", "\\'") + "'" }

func (c *candidate) inspect(db, table string) {
	var ro uint8
	var delay uint64
	q := fmt.Sprintf("SELECT toUInt8(is_readonly), toUInt64(absolute_delay) FROM system.replicas WHERE database = %s AND table = %s", quoteLit(db), quoteLit(table))
	if c.conn.QueryRow(q).Scan(&ro, &delay) == nil {
		c.replicated, c.readonly, c.delay = true, ro == 1, delay
	} else {
		q = fmt.Sprintf("SELECT toUInt64(sum(rows)) FROM system.parts WHERE active AND database = %s AND table = %s", quoteLit(db), quoteLit(table))
		_ = c.conn.QueryRow(q).Scan(&c.rows)
	}
	if c.conn.QueryRow("SELECT toUInt64(count()) FROM system.processes").Scan(&c.busy) != nil {
		c.busy = 1 << 30 // unknown: last
	}
}

// rankCandidates orders a shard's replicas, best first.
func rankCandidates(cands []candidate, replicated bool) {
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		switch {
		case a.readonly != b.readonly:
			return !a.readonly
		case !replicated && a.rows != b.rows:
			return a.rows > b.rows
		case a.inZone != b.inZone:
			return a.inZone
		case a.delay != b.delay:
			return a.delay < b.delay
		case a.busy != b.busy:
			return a.busy < b.busy
		}
		return a.pos < b.pos
	})
}

// pickNote says why a shard reads from the replica it does ("" = nothing
// worth saying).
func pickNote(cands []candidate, replicated bool, zone string) string {
	best := cands[0]
	var notes []string
	if !replicated {
		n := "table isn't replicated: read from the replica holding its rows"
		for _, c := range cands[1:] {
			if c.rows > 0 {
				n += "; other replicas hold different rows, which aren't in this backup"
				break
			}
		}
		notes = append(notes, n)
	}
	for _, c := range cands {
		if c.readonly && c.pos < best.pos {
			notes = append(notes, c.host+" is read-only (lost Keeper): skipped")
		}
	}
	if best.inZone {
		notes = append(notes, "preferred backup zone "+zone)
	}
	return strings.Join(notes, "; ")
}

// ConnFactoryFor connects to the replica each shard's backup of db.table reads.
func (a *ClickHouseAdapter) ConnFactoryFor(cluster, db, table string, maxBandwidthMB int) ([]*shardConn, error) {
	cc, err := a.getCluster(cluster)
	if err != nil {
		return nil, err
	}
	opt := backupConnOpts(cc, perShardBandwidth(maxBandwidthMB, len(cc.Shards)))
	zone := BackupZone(cluster)
	var conns []*shardConn
	for idx, shard := range cc.Shards {
		var cands []candidate
		for i, replica := range shard.Replicas {
			conn, derr := a.dial(replica.Ip, opt)
			if derr != nil {
				log.Logger.Warnf("[backup] shard %d replica %s unreachable: %v", idx+1, replica.Ip, derr)
				continue
			}
			c := candidate{host: replica.Ip, conn: conn, pos: i}
			c.inspect(db, table)
			if zone != "" {
				if m, ok := fleet.MachineByIP(replica.Ip); ok && m.Zone == zone {
					c.inZone = true
				}
			}
			cands = append(cands, c)
		}
		if len(cands) == 0 {
			return nil, fmt.Errorf("no reachable replica in shard %d", idx+1)
		}
		replicated := false
		for _, c := range cands {
			replicated = replicated || c.replicated
		}
		rankCandidates(cands, replicated)
		for _, c := range cands[1:] {
			_ = c.conn.Close()
		}
		best := cands[0]
		conns = append(conns, &shardConn{host: best.host, conn: best.conn, cluster: cc.Cluster, shard: idx + 1,
			note: pickNote(cands, replicated, zone)})
	}
	return conns, nil
}

// ---- per-cluster backup settings ------------------------------------------

const settingsKind = "backup-settings"

type clusterSettings struct {
	Zone string `json:"zone"` // prefer replicas in this zone; "" = automatic
}

// BackupZone is the zone a cluster's backups prefer to read from ("" = any).
func BackupZone(cluster string) string {
	body, err := repository.Ps.GetFleetObject(settingsKind, cluster)
	if err != nil {
		return ""
	}
	var s clusterSettings
	if json.Unmarshal(body, &s) != nil {
		return ""
	}
	return s.Zone
}

// SetBackupZone sets (or with "" clears) the zone a cluster's backups prefer.
func SetBackupZone(cluster, zone string) error {
	if _, err := repository.Ps.GetClusterbyName(cluster); err != nil {
		return errors.Errorf("cluster %s doesn't exist", cluster)
	}
	body, err := json.Marshal(clusterSettings{Zone: zone})
	if err != nil {
		return err
	}
	return repository.Ps.PutFleetObject(settingsKind, cluster, cluster, body)
}
