package backup

import (
	"sort"
	"time"

	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
)

// Health of each backup (policy): has it been succeeding on schedule?
//   running   a run is queued or running
//   retrying  the last run failed; a retry is scheduled
//   failing   the last run failed and no retry is left
//   overdue   no successful backup since the schedule said one was due
//   paused    the schedule is switched off
//   waiting   scheduled, no backup yet, the first one isn't due yet
//   healthy   the last run succeeded and the next one isn't late

const (
	HealthRunning  = "running"
	HealthRetrying = "retrying"
	HealthFailing  = "failing"
	HealthOverdue  = "overdue"
	HealthPaused   = "paused"
	HealthWaiting  = "waiting"
	HealthHealthy  = "healthy"
)

// overdueGrace is how late a scheduled backup may start before it is overdue.
const overdueGrace = 30 * time.Minute

type PolicyHealth struct {
	PolicyID    string    `json:"policy_id"`
	TaskID      string    `json:"task_id"`
	TaskName    string    `json:"task_name"`
	Cluster     string    `json:"cluster"`
	Database    string    `json:"database"`
	Table       string    `json:"table"`
	Schedule    string    `json:"schedule"` // crontab; "" = one-off
	State       string    `json:"state"`
	LastRunID   string    `json:"last_run_id,omitempty"`
	LastStatus  string    `json:"last_status,omitempty"`
	LastRunAt   time.Time `json:"last_run_at,omitempty"`
	LastSuccess time.Time `json:"last_success,omitempty"`
	NextDue     time.Time `json:"next_due,omitempty"`
	NextRetryAt time.Time `json:"next_retry_at,omitempty"`
	Attempt     int       `json:"attempt,omitempty"`
	Error       string    `json:"error,omitempty"`
}

// Health returns the health of every backup, of one cluster or ("") all.
func Health(cluster string, now time.Time) ([]PolicyHealth, error) {
	policies, err := repository.Ps.GetAllBackupPolicies()
	if err != nil {
		return nil, err
	}
	out := []PolicyHealth{}
	for _, p := range policies {
		if p.Deleted || (cluster != "" && p.ClusterName != cluster) {
			continue
		}
		runs, err := repository.Ps.GetRunsByPolicy(p.PolicyID, 100, time.Time{})
		if err != nil {
			return nil, err
		}
		out = append(out, policyHealth(p, runs, now))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Cluster != out[j].Cluster {
			return out[i].Cluster < out[j].Cluster
		}
		return out[i].Database+"."+out[i].Table < out[j].Database+"."+out[j].Table
	})
	return out, nil
}

func policyHealth(p model.BackupPolicy, runs []model.BackupRun, now time.Time) PolicyHealth {
	h := PolicyHealth{PolicyID: p.PolicyID, TaskID: p.TaskID, TaskName: p.TaskName, Cluster: p.ClusterName,
		Database: p.Database, Table: p.Table}
	if p.ScheduleType == model.BACKUP_SCHEDULED {
		h.Schedule = p.Crontab
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].CreateTime.After(runs[j].CreateTime) })
	var last *model.BackupRun
	running := false
	for i := range runs {
		r := &runs[i]
		if r.Operation != model.OP_BACKUP {
			continue
		}
		switch r.Status {
		case model.BACKUP_STATUS_QUEUED, model.BACKUP_STATUS_RUNNING:
			running = true
		case model.BACKUP_STATUS_SUCCESS:
			if h.LastSuccess.IsZero() {
				h.LastSuccess = runStart(*r)
			}
			fallthrough
		case model.BACKUP_STATUS_FAILED, model.BACKUP_STATUS_INTERRUPTED:
			if last == nil {
				last = r
			}
		}
	}
	if last != nil {
		h.LastRunID, h.LastStatus, h.LastRunAt, h.Attempt = last.RunID, last.Status, runStart(*last), attemptOf(*last)
		if last.Status != model.BACKUP_STATUS_SUCCESS {
			h.Error = last.ErrorMsg
			if h.Error == "" {
				h.Error = last.StatusReason
			}
		}
	}
	if h.Schedule != "" {
		base := h.LastSuccess
		if base.IsZero() {
			base = p.CreateTime
		}
		h.NextDue = nextDue(p, base)
	}
	switch {
	case running:
		h.State = HealthRunning
	case last != nil && last.Status != model.BACKUP_STATUS_SUCCESS:
		if !last.NextRetryAt.IsZero() && last.RetriedBy == "" {
			h.State, h.NextRetryAt = HealthRetrying, last.NextRetryAt
		} else {
			h.State = HealthFailing
		}
	case h.Schedule != "" && !p.Enabled:
		h.State = HealthPaused
	case h.Schedule != "" && !h.NextDue.IsZero() && now.After(h.NextDue.Add(overdueGrace)):
		h.State = HealthOverdue
	case h.LastSuccess.IsZero():
		h.State = HealthWaiting
	default:
		h.State = HealthHealthy
	}
	return h
}

func runStart(r model.BackupRun) time.Time {
	if !r.StartedAt.IsZero() {
		return r.StartedAt
	}
	return r.CreateTime
}

// nextDue is when the schedule next fires after base (for native backups with
// a separate full schedule, whichever fires first).
func nextDue(p model.BackupPolicy, base time.Time) time.Time {
	next, err := NextRunAfter(p.Crontab, base)
	if err != nil {
		next = time.Time{}
	}
	if p.BackupStyle == model.BACKUP_STYLE_NATIVE && p.FullCrontab != "" {
		if full, err := NextRunAfter(p.FullCrontab, base); err == nil && (next.IsZero() || full.Before(next)) {
			next = full
		}
	}
	return next
}
