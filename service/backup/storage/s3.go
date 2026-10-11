package storage

import (
	"errors"
	"fmt"
	"strings"

	"github.com/housepower/ckman/model"
)

type S3 struct {
	cfg         model.TargetS3
	compression string
	client      *S3Client
}

func NewS3(cfg model.TargetS3, compression string) *S3 {
	// trim 末尾斜杠，避免拼出 host//bucket 让 ClickHouse 解析失败
	cfg.Endpoint = strings.TrimRight(cfg.Endpoint, "/")
	return &S3{cfg: cfg, compression: compression}
}

func (s *S3) Init() error {
	if !strings.HasPrefix(s.cfg.Endpoint, "http://") && !strings.HasPrefix(s.cfg.Endpoint, "https://") {
		return errors.New("s3 endpoint must start with http:// or https://")
	}
	c, err := NewS3Client(s.cfg)
	if err != nil {
		return err
	}
	s.client = c
	_ = c.CreateBucket(s.cfg.Bucket) // 已存在不报错
	return nil
}

func (s *S3) Type() string { return model.BACKUP_S3 }

func (s *S3) BackupSQL(database, table, partition, partitionID, key string) string {
	var sb strings.Builder
	sb.WriteString(PartitionClause(partition, partitionID))
	sb.WriteString(fmt.Sprintf(" TO S3('%s/%s/%s', '%s', '%s')",
		s.cfg.Endpoint, s.cfg.Bucket, key,
		escapeSQLLiteral(s.cfg.AccessKeyID),
		escapeSQLLiteral(s.cfg.SecretAccessKey)))
	sb.WriteString(backupSettings(s.compression))
	return sb.String()
}

func (s *S3) RestoreSQL(database, table, partition, partitionID, key string) string {
	var sb strings.Builder
	sb.WriteString(PartitionClause(partition, partitionID))
	sb.WriteString(fmt.Sprintf(" FROM S3('%s/%s/%s', '%s', '%s')",
		s.cfg.Endpoint, s.cfg.Bucket, key,
		escapeSQLLiteral(s.cfg.AccessKeyID),
		escapeSQLLiteral(s.cfg.SecretAccessKey)))
	sb.WriteString(restoreSettings())
	return sb.String()
}

func (s *S3) CleanPartition(host, keyPrefix string) error {
	_ = host // S3 是 server-side 删除，host 仅 Local 后端使用
	if s.client == nil {
		return errors.New("s3 not initialized")
	}
	return s.client.Remove(s.cfg.Bucket, keyPrefix)
}

func (s *S3) CheckPartition(host, keyPrefix string, pathInfo map[string]model.PathInfo) error {
	if s.client == nil {
		return errors.New("s3 not initialized")
	}
	// 仅当备份时未压缩，md5(local raw) ↔ md5(S3 object) 才会相等；
	// 压缩开启时只能校验文件存在性与数量。
	compareMD5 := s.compression == "" || strings.EqualFold(s.compression, "none")
	_, _, _, err := s.client.CheckSum(host, s.cfg.Bucket, keyPrefix, pathInfo, s.cfg, compareMD5)
	return err
}

func escapeSQLLiteral(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// dest is the S3(...) table function for key.
func (s *S3) dest(key string) string {
	return fmt.Sprintf("S3('%s/%s/%s', '%s', '%s')",
		s.cfg.Endpoint, s.cfg.Bucket, key,
		escapeSQLLiteral(s.cfg.AccessKeyID),
		escapeSQLLiteral(s.cfg.SecretAccessKey))
}

// NativeBackupSQL returns the tail of a whole-table BACKUP TABLE; with a
// baseKey the backup only stores parts that aren't in that earlier backup.
func (s *S3) NativeBackupSQL(key, baseKey string) string {
	base := ""
	if baseKey != "" {
		base = s.dest(baseKey)
	}
	return " TO " + s.dest(key) + nativeBackupSettings(s.compression, base)
}

// NativeRestoreSQL returns the tail of a RESTORE TABLE from a native backup,
// limited to partitionIDs (whole table when empty).
func (s *S3) NativeRestoreSQL(partitionIDs []string, key string) string {
	return PartitionsClause(partitionIDs) + " FROM " + s.dest(key)
}

// DeleteNativeBackup removes all objects of one native run (every shard).
// The trailing slash keeps run r1 from matching run r10.
func (s *S3) DeleteNativeBackup(_ []string, runPrefix string) error {
	if s.client == nil {
		return errors.New("s3 not initialized")
	}
	return s.client.Remove(s.cfg.Bucket, strings.TrimRight(runPrefix, "/")+"/")
}
