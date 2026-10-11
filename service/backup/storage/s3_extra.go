package storage

import "errors"

// Dest is the S3(...) destination for key (exported for the standby syncer).
func (s *S3) Dest(key string) string { return s.dest(key) }

// DeletePrefix removes everything under prefix.
func (s *S3) DeletePrefix(prefix string) error {
	if s.client == nil {
		return errors.New("s3 not initialized")
	}
	return s.client.Remove(s.cfg.Bucket, prefix)
}
