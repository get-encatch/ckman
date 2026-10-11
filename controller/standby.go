package controller

import (
	"github.com/gin-gonic/gin"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/standby"
)

// GetFleetSettings: GET /fleet/settings
func (fc *FleetController) GetFleetSettings(c *gin.Context) {
	fc.wrapfunc(c, model.E_SUCCESS, standby.GetSettings())
}

// SaveFleetSettings: PUT /fleet/settings (admin)
func (fc *FleetController) SaveFleetSettings(c *gin.Context) {
	var s model.FleetSettings
	if err := c.ShouldBindJSON(&s); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	saved, err := standby.SaveSettings(s)
	if err != nil {
		fc.wrapfunc(c, model.E_INVALID_VARIABLE, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, saved)
}

// GetStandby: GET /fleet/standby/:cluster
func (fc *FleetController) GetStandby(c *gin.Context) {
	st, err := standby.GetStatus(c.Param("cluster"))
	if err != nil {
		fc.wrapfunc(c, model.E_RECORD_NOT_FOUND, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, st)
}

// CreateStandby: POST /fleet/standby
func (fc *FleetController) CreateStandby(c *gin.Context) {
	var req standby.CreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	taskID, err := standby.Create(req)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_CHECK_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, gin.H{"task_id": taskID})
}

// StandbyAction: POST /fleet/standby/:cluster/:action (sync, pause, resume, promote, rejoin, switchover)
func (fc *FleetController) StandbyAction(c *gin.Context) {
	cluster := c.Param("cluster")
	var err error
	var note string
	switch c.Param("action") {
	case "sync":
		err = standby.SyncNow(cluster)
	case "pause":
		err = standby.SetPaused(cluster, true)
	case "resume":
		err = standby.SetPaused(cluster, false)
	case "promote":
		note, err = standby.Promote(cluster, c.Query("final_sync") == "true")
	case "rejoin":
		note, err = standby.Rejoin(cluster)
		if err == nil {
			note = "snapshot: " + note
		}
	case "switchover":
		err = standby.Switchover(cluster)
	default:
		fc.wrapfunc(c, model.E_INVALID_PARAMS, "unknown action")
		return
	}
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_UPDATE_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, gin.H{"note": note})
}

// DeleteStandby: DELETE /fleet/standby/:cluster?purge=true
func (fc *FleetController) DeleteStandby(c *gin.Context) {
	if err := standby.Remove(c.Param("cluster"), c.Query("purge") == "true"); err != nil {
		fc.wrapfunc(c, model.E_DATA_DELETE_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, nil)
}
