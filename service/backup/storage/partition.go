package storage

import (
	"fmt"
	"strings"
)

// PartitionClause returns the PARTITION clause for one partition of a
// BACKUP / RESTORE / ALTER statement.
//
// ClickHouse's partition ID works for every partition key: "all" is the ID of
// an unpartitioned table (no clause = the whole table), and multi-column or
// string keys get an ID even though their partition *name* (e.g. tuple() or
// (202610,'eu')) can't be passed back as a quoted literal. Runs recorded
// before IDs were stored fall back to the quoted partition name.
func PartitionClause(partition, partitionID string) string {
	switch {
	case partitionID == "all", partitionID == "" && partition == "all":
		return ""
	case partitionID != "":
		return fmt.Sprintf(" PARTITION ID '%s'", escapeSQLLiteral(partitionID))
	default:
		return fmt.Sprintf(" PARTITION '%s'", escapeSQLLiteral(partition))
	}
}

// PartitionsClause returns "PARTITIONS ID 'a', ID 'b'" for restoring a subset
// of a whole-table backup, or "" when ids is empty or covers the whole table.
func PartitionsClause(ids []string) string {
	var parts []string
	for _, id := range ids {
		if id == "" || id == "all" {
			return ""
		}
		parts = append(parts, fmt.Sprintf("ID '%s'", escapeSQLLiteral(id)))
	}
	if len(parts) == 0 {
		return ""
	}
	return " PARTITIONS " + strings.Join(parts, ", ")
}

// nativeBackupSettings is backupSettings for whole-table native backups:
// file deduplication stays on (it is what makes base_backup incremental) and
// base_backup points at the previous backup of the chain.
func nativeBackupSettings(compression, baseBackup string) string {
	var parts []string
	if c := strings.TrimSpace(compression); c != "" {
		parts = append(parts, fmt.Sprintf("compression_method='%s'", escapeSQLLiteral(c)))
	}
	parts = append(parts, "compression_level=6")
	if baseBackup != "" {
		parts = append(parts, "base_backup = "+baseBackup)
	}
	return " SETTINGS " + strings.Join(parts, ", ")
}
