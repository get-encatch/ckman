package backup

import (
	"context"
	"time"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
)

// ReconcileInterval is the period between reconcile runs. spec §5.4 defines 60 seconds.
const ReconcileInterval = 60 * time.Second

// CronAdapter lets Scheduler avoid direct coupling to the robfig/cron package,
// making unit-testing straightforward.
// Task 21 will wire in a real RobfigCronAdapter in main.go.
type CronAdapter interface {
	Add(id, spec string, fn func() error)
	Remove(id string)
}

// PolicyRepo lets Scheduler avoid depending on a specific persistent layer.
// It only exposes reading active policies.
type PolicyRepo interface {
	Active(instance string) []model.BackupPolicy
}

// Scheduler periodically syncs the backup_policy table with the cron registry.
type Scheduler struct {
	self    string
	cron    CronAdapter
	policy  PolicyRepo
	fn      func(model.BackupPolicy) // real business: trigger one Submit
	fullFn  func(model.BackupPolicy) // native policies with a full_crontab: trigger a full backup
	tracked map[string]string        // policy_id -> registered crontab
	cancel  context.CancelFunc
}

// NewScheduler creates a new Scheduler. self is the ckman instance name used to
// filter which policies belong to this instance.
func NewScheduler(self string, cron CronAdapter, policy PolicyRepo,
	fn func(model.BackupPolicy)) *Scheduler {
	return &Scheduler{
		self:    self,
		cron:    cron,
		policy:  policy,
		fn:      fn,
		tracked: map[string]string{},
	}
}

// Start immediately runs one Reconcile then launches a background goroutine that
// repeats at ReconcileInterval until ctx is cancelled or Stop is called.
// fullEntryID is the cron entry of a native policy's full-backup schedule.
func fullEntryID(policyID string) string { return policyID + "#full" }

// WithFull registers fn for the full-backup schedule of native policies
// (BackupPolicy.FullCrontab); Crontab then drives the incrementals.
func (s *Scheduler) WithFull(fn func(model.BackupPolicy)) *Scheduler {
	s.fullFn = fn
	return s
}

func (s *Scheduler) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)
	s.Reconcile() // run immediately on startup
	go func() {
		t := time.NewTicker(ReconcileInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.Reconcile()
			}
		}
	}()
}

// Stop cancels the background reconcile goroutine.
func (s *Scheduler) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
}

// Reconcile pulls active policies from PolicyRepo, diffs them against the current
// cron registry, then adds/removes/replaces cron jobs as needed.
// It is idempotent: calling it when nothing changed is a no-op.
//
// Concurrency note: Reconcile is called serially (on startup + ticker), so
// tracked does not need a mutex.
func (s *Scheduler) Reconcile() {
	policies := s.policy.Active(s.self)

	// Build the desired state map: policy_id -> crontab.
	want := make(map[string]string, len(policies))
	entries := make([]schedEntry, 0, len(policies))
	for _, p := range policies {
		want[p.PolicyID] = p.Crontab
		entries = append(entries, schedEntry{p.PolicyID, p.Crontab, p, s.fn})
		if s.fullFn != nil && p.BackupStyle == model.BACKUP_STYLE_NATIVE && p.FullCrontab != "" {
			want[fullEntryID(p.PolicyID)] = p.FullCrontab
			entries = append(entries, schedEntry{fullEntryID(p.PolicyID), p.FullCrontab, p, s.fullFn})
		}
	}

	// Remove: in tracked but not in want.
	for id := range s.tracked {
		if _, ok := want[id]; !ok {
			s.cron.Remove(id)
			delete(s.tracked, id)
			log.Logger.Infof("[scheduler] reconcile remove %s", id)
		}
	}

	// Add / replace: in want but not yet tracked, or crontab changed.
	for _, en := range entries {
		registered, exists := s.tracked[en.id]
		if exists && registered == en.spec {
			continue // stable, no-op
		}
		if exists {
			s.cron.Remove(en.id)
			log.Logger.Infof("[scheduler] reconcile replace %s: %s -> %s", en.id, registered, en.spec)
		} else {
			log.Logger.Infof("[scheduler] reconcile add %s: %s", en.id, en.spec)
		}
		policy, fn := en.policy, en.fn
		s.cron.Add(en.id, en.spec, func() error {
			fn(policy)
			return nil
		})
		s.tracked[en.id] = en.spec
	}
}

type schedEntry struct {
	id     string
	spec   string
	policy model.BackupPolicy
	fn     func(model.BackupPolicy)
}
