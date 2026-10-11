package backup

import (
	"errors"
	"testing"

	"github.com/housepower/ckman/model"
)

func TestValidateBucketName(t *testing.T) {
	for _, ok := range []string{"ckbackup", "ck-backup.2026", "abc"} {
		if err := ValidateBucketName(ok); err != nil {
			t.Errorf("%q should be valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"ab", "CKBackup", "-ck", "ck_backup", "ck..b", "192.168.1.10", "ck backup"} {
		if err := ValidateBucketName(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestResolvePolicyTarget(t *testing.T) {
	orig := lookupConnection
	defer func() { lookupConnection = orig }()
	lookupConnection = func(id string) (model.StorageConnection, error) {
		if id != "c1" {
			return model.StorageConnection{}, errors.New("not found")
		}
		return model.StorageConnection{ConnectionID: "c1", S3: model.TargetS3{
			Endpoint: "http://s3:9000", AccessKeyID: "AK", SecretAccessKey: "SK", Bucket: "ignored"}}, nil
	}

	p := model.BackupPolicy{TargetType: model.BACKUP_S3, ConnectionID: "c1", S3: model.TargetS3{Bucket: "events"}}
	got, err := ResolvePolicyTarget(p)
	if err != nil {
		t.Fatal(err)
	}
	if got.S3.Endpoint != "http://s3:9000" || got.S3.SecretAccessKey != "SK" || got.S3.Bucket != "events" {
		t.Fatalf("expected connection settings with the policy's bucket, got %+v", got.S3)
	}

	legacy := model.BackupPolicy{TargetType: model.BACKUP_S3, S3: model.TargetS3{Endpoint: "http://x", Bucket: "b"}}
	if got, _ := ResolvePolicyTarget(legacy); got.S3 != legacy.S3 {
		t.Fatalf("policies without a connection must be unchanged: %+v", got.S3)
	}

	if _, err := ResolvePolicyTarget(model.BackupPolicy{TargetType: model.BACKUP_S3, ConnectionID: "gone"}); err == nil {
		t.Fatal("a missing connection must fail the run")
	}
}
