package backup

import (
	"errors"
	"fmt"
	"time"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
)

// A failed or interrupted backup is retried: up to len(retryDelays) more
// attempts, attempt n+1 after retryDelays[n-1]. A retry runs like the run it
// retries (same trigger, so a full backup stays full) and is linked to it
// (Attempt, RetryOf, RetriedBy). It is dropped when the policy was disabled
// or deleted, or a later backup of the policy succeeded. Pending retries are
// re-armed from the ledger when ckman starts. Restores are never retried.

var retryDelays = []time.Duration{5 * time.Minute, 15 * time.Minute, 45 * time.Minute}

// MaxAttempts is how many times one backup is tried in all.
var MaxAttempts = len(retryDelays) + 1

func attemptOf(r model.BackupRun) int {
	if r.Attempt == 0 {
		return 1
	}
	return r.Attempt
}

func retryable(r model.BackupRun) bool {
	return r.Operation == model.OP_BACKUP &&
		(r.Status == model.BACKUP_STATUS_FAILED || r.Status == model.BACKUP_STATUS_INTERRUPTED)
}

// AfterRun schedules a retry if the run failed and has attempts left.
func (s *Service) AfterRun(runID string) {
	r, err := s.repo.GetRun(runID)
	if err != nil || !retryable(r) || r.RetriedBy != "" || !r.NextRetryAt.IsZero() {
		return
	}
	n := attemptOf(r)
	if n > len(retryDelays) {
		log.Logger.Warnf("[backup] run %s (%s.%s) failed on attempt %d of %d: giving up", runID, r.Database, r.Table, n, MaxAttempts)
		return
	}
	delay := retryDelays[n-1]
	r.NextRetryAt = s.now().Add(delay)
	if err := s.repo.UpdateRun(r); err != nil {
		log.Logger.Errorf("[backup] schedule retry of %s: %v", runID, err)
		return
	}
	log.Logger.Infof("[backup] run %s (%s.%s) failed: attempt %d in %s", runID, r.Database, r.Table, n+1, delay)
	s.armRetry(runID, delay)
}

func (s *Service) armRetry(runID string, d time.Duration) {
	time.AfterFunc(d, func() {
		if _, err := s.retry(runID, false); err != nil {
			log.Logger.Warnf("[backup] retry of %s: %v", runID, err)
		}
	})
}

// RetryRun retries a failed backup now (the Retry button), whatever the
// attempt count.
func (s *Service) RetryRun(runID string) (string, error) {
	return s.retry(runID, true)
}

func (s *Service) retry(runID string, manual bool) (string, error) {
	r, err := s.repo.GetRun(runID)
	if err != nil {
		return "", err
	}
	if r.RetriedBy != "" {
		return r.RetriedBy, nil
	}
	if !retryable(r) {
		return "", fmt.Errorf("only failed or interrupted backups can be retried (this run is %s)", r.Status)
	}
	drop := func(why string) (string, error) {
		r.NextRetryAt = time.Time{}
		_ = s.repo.UpdateRun(r)
		return "", errors.New(why)
	}
	p, err := s.repo.GetPolicy(r.PolicyID)
	if err != nil || p.Deleted {
		return drop("the backup was deleted")
	}
	if s.clusterExists != nil && !s.clusterExists(p.ClusterName) {
		return drop("cluster " + p.ClusterName + " no longer exists")
	}
	if !manual {
		if p.ScheduleType == model.BACKUP_SCHEDULED && !p.Enabled {
			return drop("the backup is paused")
		}
		if s.laterSuccess(r) {
			return drop("a later backup succeeded")
		}
	}
	root := r.RetryOf
	if root == "" {
		root = r.RunID
	}
	newID, err := s.submit(p, r.TriggerType, attemptOf(r)+1, root)
	if err != nil {
		return "", err
	}
	r.RetriedBy, r.NextRetryAt = newID, time.Time{}
	if err := s.repo.UpdateRun(r); err != nil {
		log.Logger.Errorf("[backup] link retry %s -> %s: %v", runID, newID, err)
	}
	return newID, nil
}

func (s *Service) laterSuccess(r model.BackupRun) bool {
	runs, err := s.repo.RunsByPolicy(r.PolicyID)
	if err != nil {
		return false
	}
	for _, x := range runs {
		if x.Operation == model.OP_BACKUP && x.Status == model.BACKUP_STATUS_SUCCESS && x.CreateTime.After(r.CreateTime) {
			return true
		}
	}
	return false
}

// armPendingRetries re-arms the retries of this instance's failed runs after a
// restart; overdue ones fire within a minute.
func (s *Service) armPendingRetries() {
	if s.allRuns == nil {
		return
	}
	runs, err := s.allRuns()
	if err != nil {
		return
	}
	for _, r := range runs {
		if r.Instance != s.self || r.NextRetryAt.IsZero() || r.RetriedBy != "" {
			continue
		}
		d := r.NextRetryAt.Sub(s.now())
		if d < 30*time.Second {
			d = 30 * time.Second
		}
		s.armRetry(r.RunID, d)
	}
}
