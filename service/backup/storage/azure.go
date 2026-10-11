package storage

import (
	"errors"
	"fmt"
	"strings"

	"github.com/housepower/ckman/model"
)

// Azure stores backups in an Azure Blob container through ClickHouse's
// AzureBlobStorage(url, container, path, account, key) destination.
type Azure struct {
	cfg         model.TargetAzure
	compression string
	client      *AzureClient
}

func NewAzure(cfg model.TargetAzure, compression string) *Azure {
	cfg.Endpoint = strings.TrimRight(cfg.Endpoint, "/")
	return &Azure{cfg: cfg, compression: compression}
}

func (a *Azure) Init() error {
	if !strings.HasPrefix(a.cfg.Endpoint, "http://") && !strings.HasPrefix(a.cfg.Endpoint, "https://") {
		return errors.New("Azure endpoint must start with http:// or https://")
	}
	c, err := NewAzureClient(a.cfg)
	if err != nil {
		return err
	}
	a.client = c
	return c.CreateContainer(a.cfg.Container)
}

func (a *Azure) Type() string { return model.BACKUP_AZURE }

// Dest is the AzureBlobStorage(...) destination for key.
func (a *Azure) Dest(key string) string {
	return fmt.Sprintf("AzureBlobStorage('%s', '%s', '%s', '%s', '%s')",
		a.cfg.Endpoint, escapeSQLLiteral(a.cfg.Container), key,
		escapeSQLLiteral(a.cfg.AccountName), escapeSQLLiteral(a.cfg.AccountKey))
}

func (a *Azure) BackupSQL(database, table, partition, partitionID, key string) string {
	return PartitionClause(partition, partitionID) + " TO " + a.Dest(key) + backupSettings(a.compression)
}

func (a *Azure) RestoreSQL(database, table, partition, partitionID, key string) string {
	return PartitionClause(partition, partitionID) + " FROM " + a.Dest(key) + restoreSettings()
}

func (a *Azure) CleanPartition(_ string, keyPrefix string) error {
	if a.client == nil {
		return errors.New("azure not initialized")
	}
	return a.client.DeletePrefix(a.cfg.Container, keyPrefix)
}

// CheckPartition verifies the backup exists; Azure has no per-file md5
// comparison here.
func (a *Azure) CheckPartition(_ string, keyPrefix string, _ map[string]model.PathInfo) error {
	if a.client == nil {
		return errors.New("azure not initialized")
	}
	names, err := a.client.ListBlobs(a.cfg.Container, keyPrefix)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return fmt.Errorf("no backup files under %s", keyPrefix)
	}
	return nil
}

func (a *Azure) NativeBackupSQL(key, baseKey string) string {
	base := ""
	if baseKey != "" {
		base = a.Dest(baseKey)
	}
	return " TO " + a.Dest(key) + nativeBackupSettings(a.compression, base)
}

func (a *Azure) NativeRestoreSQL(partitionIDs []string, key string) string {
	return PartitionsClause(partitionIDs) + " FROM " + a.Dest(key)
}

func (a *Azure) DeleteNativeBackup(_ []string, runPrefix string) error {
	if a.client == nil {
		return errors.New("azure not initialized")
	}
	return a.client.DeletePrefix(a.cfg.Container, strings.TrimRight(runPrefix, "/")+"/")
}

// DeletePrefix removes everything under prefix.
func (a *Azure) DeletePrefix(prefix string) error {
	if a.client == nil {
		return errors.New("azure not initialized")
	}
	return a.client.DeletePrefix(a.cfg.Container, prefix)
}
