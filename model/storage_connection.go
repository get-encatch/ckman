package model

import "time"

const STORAGE_CONN_S3 = "s3"

// StorageConnection is a saved S3 endpoint and credentials. Backup policies
// refer to it by ConnectionID and only choose the bucket, so the keys live in
// one place. The secret key is stored encrypted.
type StorageConnection struct {
	ConnectionID string    `json:"connection_id"`
	Name         string    `json:"name"`
	Type         string    `json:"type"` // s3
	S3           TargetS3  `json:"s3"`   // Bucket is unused: each backup picks its own
	CreateTime   time.Time `json:"create_time"`
	UpdateTime   time.Time `json:"update_time"`
}
