package model

// AccessConf is set on fleet standby clusters. While ReadOnly is true every
// app user (default and the users in UsersConf) gets a read-only profile, and
// ckman itself connects through SyncUser so it can keep restoring data and
// applying schema changes.
type AccessConf struct {
	ReadOnly     bool   `json:"readOnly"`
	SyncUser     string `json:"syncUser,omitempty"`
	SyncPassword string `json:"syncPassword,omitempty"`
}

const (
	CkfSyncUser        = "ckman_sync"
	CkfReadOnlyProfile = "ckf_readonly"
)

// ReadOnly reports whether app users are currently read-only.
func (config *CKManClickHouseConfig) ReadOnly() bool {
	return config.Access != nil && config.Access.ReadOnly
}
