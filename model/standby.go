package model

import "time"

// A standby keeps a copy of a cluster in another zone, either as a separate
// cluster fed from object storage ("storage") or as extra replicas of the
// primary placed in that zone ("replica").

const (
	FleetKindStandby  = "standby"
	FleetKindSettings = "settings"

	StandbyModeStorage = "storage"
	StandbyModeReplica = "replica"

	DefaultStandbyIntervalMin = 15
	MinStandbyIntervalMin     = 5
)

// FleetSettings are admin settings for the whole fleet.
type FleetSettings struct {
	StandbyIntervalMin int `json:"standby_interval_min"` // default sync interval for new standbys
}

type Standby struct {
	Primary      string    `json:"primary"` // the protected cluster; also the standby's ID
	Mode         string    `json:"mode"`
	Zone         string    `json:"zone"`
	Cluster      string    `json:"cluster,omitempty"`       // storage mode: the standby cluster
	ConnectionID string    `json:"connection_id,omitempty"` // storage mode: S3 or Azure connection
	Bucket       string    `json:"bucket,omitempty"`        // bucket or container
	IntervalMin  int       `json:"interval_min"`            // 0 = the fleet default
	Databases    []string  `json:"databases,omitempty"`     // empty = every user database
	ReplicaIPs   []string  `json:"replica_ips,omitempty"`   // replica mode: standby replicas, one per shard
	Paused       bool      `json:"paused"`
	PromotedAt   time.Time `json:"promoted_at,omitempty"`
	CreateTime   time.Time `json:"create_time"`

	// sync state (storage mode)
	State        string                   `json:"state"` // creating | ready | syncing | failed | promoted
	StateMessage string                   `json:"state_message,omitempty"`
	LastStart    time.Time                `json:"last_start,omitempty"`
	LastEnd      time.Time                `json:"last_end,omitempty"`
	LastSuccess  time.Time                `json:"last_success,omitempty"` // standby has the primary's data as of this time
	LastError    string                   `json:"last_error,omitempty"`
	LastSynced   int                      `json:"last_synced"` // partitions copied by the last sync
	Syncs        int                      `json:"syncs"`
	ChainID      string                   `json:"chain_id,omitempty"` // current backup chain in the bucket
	ChainRuns    int                      `json:"chain_runs"`
	Tables       map[string]*StandbyTable `json:"tables,omitempty"`       // "db.table"
	TableUUIDs   map[string]string        `json:"table_uuids,omitempty"`  // primary table UUID -> "db.table", to follow renames
	SchemaNotes  []string                 `json:"schema_notes,omitempty"` // schema differences the last sync left as they are

	// lifecycle
	Fenced     bool      `json:"fenced"`                // promoted: the old primary is read-only
	FenceError string    `json:"fence_error,omitempty"` // why fencing hasn't worked yet (retried)
	FenceTried time.Time `json:"fence_tried,omitempty"`
	Previous   string    `json:"previous,omitempty"`    // after a rejoin or switchover: the cluster that was primary
	ReversedAt time.Time `json:"reversed_at,omitempty"` // when the roles were last swapped
	Snapshot   string    `json:"snapshot,omitempty"`    // rejoin: the old primary's safety backup in the bucket
}

// StandbyTable is the synced state of one table: per shard, the fingerprint
// of each partition last copied and the latest backup key (the next base).
type StandbyTable struct {
	Shards      map[int]map[string]string `json:"shards"`
	LastKey     map[int]string            `json:"last_key"`
	PrimaryRows uint64                    `json:"primary_rows"`
	StandbyRows uint64                    `json:"standby_rows"`
}
