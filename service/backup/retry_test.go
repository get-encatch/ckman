package backup

import (
	"testing"
	"time"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
)

func retrySetup(t *testing.T) (*Service, *memRepo, *fakePool, time.Time) {
	log.InitLoggerConsole()
	repo, pool := newMemRepo(), &fakePool{}
	now := time.Date(2026, 10, 12, 3, 0, 0, 0, time.UTC)
	s := NewService("self", repo, pool)
	s.now = func() time.Time { return now }
	_ = repo.CreatePolicy(model.BackupPolicy{PolicyID: "p", ClusterName: "c", Database: "db", Table: "t",
		ScheduleType: model.BACKUP_SCHEDULED, Crontab: "0 0 2 * * *", Enabled: true})
	return s, repo, pool, now
}

func failedRun(repo *memRepo, id string, attempt int, created time.Time) {
	_ = repo.CreateRun(model.BackupRun{RunID: id, PolicyID: "p", Operation: model.OP_BACKUP, TriggerType: model.TRIGGER_CRON_FULL,
		Status: model.BACKUP_STATUS_FAILED, ErrorMsg: "s3 down", Attempt: attempt, CreateTime: created})
}

func TestRetryChain(t *testing.T) {
	s, repo, pool, now := retrySetup(t)
	failedRun(repo, "r1", 0, now.Add(-time.Minute))
	s.AfterRun("r1")
	if r, _ := repo.GetRun("r1"); !r.NextRetryAt.Equal(now.Add(5 * time.Minute)) {
		t.Fatalf("retry scheduled at %v, want +5m", r.NextRetryAt)
	}
	id, err := s.retry("r1", false)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := repo.GetRun(id)
	if r2.Attempt != 2 || r2.RetryOf != "r1" || r2.TriggerType != model.TRIGGER_CRON_FULL || len(pool.in) != 1 {
		t.Fatalf("retry run: %+v (queued %v)", r2, pool.in)
	}
	if r1, _ := repo.GetRun("r1"); r1.RetriedBy != id || !r1.NextRetryAt.IsZero() {
		t.Fatalf("r1 not linked: %+v", r1)
	}
	// the last attempt is not retried again
	failedRun(repo, "r4", MaxAttempts, now)
	s.AfterRun("r4")
	if r, _ := repo.GetRun("r4"); !r.NextRetryAt.IsZero() {
		t.Fatal("retried past the last attempt")
	}
}

func TestRetryDropped(t *testing.T) {
	s, repo, _, now := retrySetup(t)
	failedRun(repo, "r1", 0, now.Add(-time.Hour))
	_ = repo.CreateRun(model.BackupRun{RunID: "ok", PolicyID: "p", Operation: model.OP_BACKUP,
		Status: model.BACKUP_STATUS_SUCCESS, CreateTime: now.Add(-time.Minute)})
	if _, err := s.retry("r1", false); err == nil {
		t.Fatal("retried although a later backup succeeded")
	}
	if _, err := s.RetryRun("r1"); err != nil {
		t.Fatalf("manual retry refused: %v", err)
	}
	p, _ := repo.GetPolicy("p")
	p.Enabled = false
	_ = repo.UpdatePolicy(p)
	failedRun(repo, "r9", 0, now)
	if _, err := s.retry("r9", false); err == nil {
		t.Fatal("retried a paused backup")
	}
}

func TestPolicyHealth(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	daily := model.BackupPolicy{PolicyID: "p", ScheduleType: model.BACKUP_SCHEDULED, Crontab: "0 0 2 * * *", Enabled: true,
		CreateTime: now.Add(-72 * time.Hour)}
	run := func(status string, at time.Time) model.BackupRun {
		return model.BackupRun{RunID: status + at.String(), Operation: model.OP_BACKUP, Status: status, StartedAt: at, CreateTime: at}
	}
	today2am := time.Date(2026, 10, 12, 2, 0, 0, 0, time.UTC)
	paused := daily
	paused.Enabled = false
	fresh := daily
	fresh.CreateTime = now.Add(-time.Hour)
	cases := []struct {
		name   string
		policy model.BackupPolicy
		runs   []model.BackupRun
		want   string
	}{
		{"healthy", daily, []model.BackupRun{run(model.BACKUP_STATUS_SUCCESS, today2am)}, HealthHealthy},
		{"overdue", daily, []model.BackupRun{run(model.BACKUP_STATUS_SUCCESS, today2am.Add(-48*time.Hour))}, HealthOverdue},
		{"failing", daily, []model.BackupRun{run(model.BACKUP_STATUS_FAILED, today2am), run(model.BACKUP_STATUS_SUCCESS, today2am.Add(-24*time.Hour))}, HealthFailing},
		{"running", daily, []model.BackupRun{run(model.BACKUP_STATUS_RUNNING, now), run(model.BACKUP_STATUS_FAILED, today2am)}, HealthRunning},
		{"waiting", fresh, nil, HealthWaiting},
		{"paused", paused, nil, HealthPaused},
		{"skipped runs don't count", daily, []model.BackupRun{run(model.BACKUP_STATUS_SKIPPED, now), run(model.BACKUP_STATUS_SUCCESS, today2am)}, HealthHealthy},
	}
	for _, c := range cases {
		h := policyHealth(c.policy, c.runs, now)
		if h.State != c.want {
			t.Errorf("%s: state %s, want %s (next due %v)", c.name, h.State, c.want, h.NextDue)
		}
	}
	retrying := run(model.BACKUP_STATUS_FAILED, today2am)
	retrying.NextRetryAt = now.Add(5 * time.Minute)
	if h := policyHealth(daily, []model.BackupRun{retrying}, now); h.State != HealthRetrying || h.NextRetryAt.IsZero() {
		t.Errorf("retrying: %+v", h)
	}
}
