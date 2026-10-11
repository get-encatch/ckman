package backup

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/go-basic/uuid"
	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/backup/storage"
)

// Storage connections are saved S3 endpoints and credentials. Backup policies
// refer to one by ID and only choose a bucket, so keys are kept (encrypted) in
// one place and never travel with each policy.

var bucketNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

// ValidateBucketName applies the S3 bucket naming rules.
func ValidateBucketName(name string) error {
	switch {
	case !bucketNameRe.MatchString(name):
		return fmt.Errorf("bucket name %q: use 3-63 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit", name)
	case strings.Contains(name, ".."):
		return fmt.Errorf("bucket name %q must not contain two dots in a row", name)
	case net.ParseIP(name) != nil:
		return fmt.Errorf("bucket name %q must not look like an IP address", name)
	}
	return nil
}

func decodeConnection(c model.StorageConnection) model.StorageConnection {
	c.S3.SecretAccessKey = common.AesDecryptECB(c.S3.SecretAccessKey)
	return c
}

// ListConnections returns all saved connections with their secrets decrypted.
func ListConnections() ([]model.StorageConnection, error) {
	conns, err := repository.Ps.GetAllStorageConnections()
	if err != nil {
		return nil, err
	}
	for i := range conns {
		conns[i] = decodeConnection(conns[i])
	}
	return conns, nil
}

// GetConnection returns one saved connection with its secret decrypted.
func GetConnection(id string) (model.StorageConnection, error) {
	c, err := repository.Ps.GetStorageConnection(id)
	if err != nil {
		return model.StorageConnection{}, err
	}
	return decodeConnection(c), nil
}

// lookupConnection is swapped out in tests.
var lookupConnection = GetConnection

// SaveConnection validates, tests and stores a connection (new when
// ConnectionID is empty). Empty keys on an update keep the stored ones.
func SaveConnection(c model.StorageConnection) (model.StorageConnection, error) {
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" {
		return c, errors.New("name is required")
	}
	c.Type = model.STORAGE_CONN_S3
	c.S3.Endpoint = strings.TrimRight(strings.TrimSpace(c.S3.Endpoint), "/")
	if !strings.HasPrefix(c.S3.Endpoint, "http://") && !strings.HasPrefix(c.S3.Endpoint, "https://") {
		return c, errors.New("endpoint must start with http:// or https://")
	}
	c.S3.UseSSL = strings.HasPrefix(c.S3.Endpoint, "https://")
	c.S3.Bucket = ""

	all, err := ListConnections()
	if err != nil {
		return c, err
	}
	for _, other := range all {
		if other.ConnectionID != c.ConnectionID && strings.EqualFold(other.Name, c.Name) {
			return c, fmt.Errorf("a connection named %q already exists", c.Name)
		}
	}
	if c.ConnectionID != "" {
		old, gerr := GetConnection(c.ConnectionID)
		if gerr != nil {
			return c, fmt.Errorf("connection %s: %w", c.ConnectionID, gerr)
		}
		if c.S3.AccessKeyID == "" {
			c.S3.AccessKeyID = old.S3.AccessKeyID
		}
		if c.S3.SecretAccessKey == "" {
			c.S3.SecretAccessKey = old.S3.SecretAccessKey
		}
		c.CreateTime = old.CreateTime
	}
	if c.S3.AccessKeyID == "" || c.S3.SecretAccessKey == "" {
		return c, errors.New("access key and secret key are required")
	}
	if _, err := ListS3Buckets(c.S3); err != nil {
		return c, fmt.Errorf("can't connect with these settings: %w", err)
	}

	stored := c
	stored.S3.SecretAccessKey = common.AesEncryptECB(c.S3.SecretAccessKey)
	if c.ConnectionID == "" {
		c.ConnectionID = uuid.New()
		stored.ConnectionID = c.ConnectionID
		err = repository.Ps.CreateStorageConnection(stored)
	} else {
		err = repository.Ps.UpdateStorageConnection(stored)
	}
	return c, err
}

// DeleteConnection removes a connection that no backup policy uses.
func DeleteConnection(id string) error {
	policies, err := repository.Ps.GetAllBackupPolicies()
	if err != nil {
		return err
	}
	var users []string
	for _, p := range policies {
		if !p.Deleted && p.ConnectionID == id {
			name := p.TaskName
			if name == "" {
				name = p.Database + "." + p.Table
			}
			users = append(users, name)
		}
	}
	if len(users) > 0 {
		return fmt.Errorf("connection is used by backups: %s", strings.Join(users, ", "))
	}
	return repository.Ps.DeleteStorageConnection(id)
}

// ListS3Buckets connects with cfg and lists its buckets (also a connection test).
func ListS3Buckets(cfg model.TargetS3) ([]string, error) {
	cfg.Bucket = ""
	client, err := storage.NewS3Client(cfg)
	if err != nil {
		return nil, err
	}
	return client.ListBuckets()
}

// ConnectionBuckets lists the buckets of a saved connection.
func ConnectionBuckets(id string) ([]string, error) {
	c, err := lookupConnection(id)
	if err != nil {
		return nil, err
	}
	return ListS3Buckets(c.S3)
}

// CreateConnectionBucket creates a bucket through a saved connection; an
// existing bucket owned by the same credentials is fine.
func CreateConnectionBucket(id, bucket string) error {
	if err := ValidateBucketName(bucket); err != nil {
		return err
	}
	c, err := lookupConnection(id)
	if err != nil {
		return err
	}
	cfg := c.S3
	cfg.Bucket = ""
	client, err := storage.NewS3Client(cfg)
	if err != nil {
		return err
	}
	return client.CreateBucket(bucket)
}

// ResolvePolicyTarget fills a policy's S3 settings from its saved connection,
// keeping the policy's own bucket. Policies without a connection are returned
// unchanged.
func ResolvePolicyTarget(p model.BackupPolicy) (model.BackupPolicy, error) {
	if p.ConnectionID == "" || p.TargetType != model.BACKUP_S3 {
		return p, nil
	}
	c, err := lookupConnection(p.ConnectionID)
	if err != nil {
		return p, fmt.Errorf("storage connection %s: %w", p.ConnectionID, err)
	}
	bucket := p.S3.Bucket
	p.S3 = c.S3
	p.S3.Bucket = bucket
	return p, nil
}

// prepareConnectionTarget validates the connection and bucket of a request
// that uses a saved connection, creates the bucket if needed, and returns the
// S3 settings to store on the policy: only the bucket, no credentials.
func prepareConnectionTarget(connectionID string, s3 model.TargetS3) (model.TargetS3, error) {
	bucket := strings.TrimSpace(s3.Bucket)
	if err := ValidateBucketName(bucket); err != nil {
		return s3, err
	}
	if err := CreateConnectionBucket(connectionID, bucket); err != nil {
		return s3, fmt.Errorf("bucket %s: %w", bucket, err)
	}
	return model.TargetS3{Bucket: bucket}, nil
}
