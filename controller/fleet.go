package controller

import (
	"github.com/gin-gonic/gin"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/fleet"
	"github.com/housepower/ckman/service/fleetdeploy"
)

// FleetController manages the machines that host containerised ClickHouse
// and Keeper instances.
type FleetController struct {
	Controller
}

func NewFleetController(wrapfunc Wrapfunc) *FleetController {
	return &FleetController{Controller: Controller{wrapfunc: wrapfunc}}
}

// ListMachines: GET /fleet/machines
func (fc *FleetController) ListMachines(c *gin.Context) {
	machines, err := fleet.ListMachines()
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_SELECT_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, machines)
}

// GetMachine: GET /fleet/machine/:id
func (fc *FleetController) GetMachine(c *gin.Context) {
	m, err := fleet.GetMachine(c.Param("id"))
	if err != nil {
		fc.wrapfunc(c, model.E_RECORD_NOT_FOUND, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, m)
}

// CreateMachine: POST /fleet/machines. Checks SSH and Docker before saving.
func (fc *FleetController) CreateMachine(c *gin.Context) {
	var m model.Machine
	if err := c.ShouldBindJSON(&m); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	m.ID = ""
	saved, err := fleet.SaveMachine(m)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_INSERT_FAILED, err)
		return
	}
	saved.SshPassword = ""
	fc.wrapfunc(c, model.E_SUCCESS, saved)
}

// UpdateMachine: PUT /fleet/machine/:id. An empty password keeps the stored one.
func (fc *FleetController) UpdateMachine(c *gin.Context) {
	var m model.Machine
	if err := c.ShouldBindJSON(&m); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	m.ID = c.Param("id")
	saved, err := fleet.SaveMachine(m)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_UPDATE_FAILED, err)
		return
	}
	saved.SshPassword = ""
	fc.wrapfunc(c, model.E_SUCCESS, saved)
}

// DeleteMachine: DELETE /fleet/machine/:id
func (fc *FleetController) DeleteMachine(c *gin.Context) {
	if err := fleet.DeleteMachine(c.Param("id")); err != nil {
		fc.wrapfunc(c, model.E_DATA_DELETE_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, nil)
}

// CheckMachine: POST /fleet/machine/:id/check re-reads facts and status.
func (fc *FleetController) CheckMachine(c *gin.Context) {
	m, err := fleet.CheckMachine(c.Param("id"))
	if err != nil {
		fc.wrapfunc(c, model.E_RECORD_NOT_FOUND, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, m)
}

// MachineStats: GET /fleet/machine/:id/stats
func (fc *FleetController) MachineStats(c *gin.Context) {
	s, err := fleet.MachineStatsByID(c.Param("id"))
	if err != nil {
		fc.wrapfunc(c, model.E_RECORD_NOT_FOUND, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, s)
}

// FleetStats: GET /fleet/stats (every machine)
func (fc *FleetController) FleetStats(c *gin.Context) {
	s, err := fleet.AllStats()
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_SELECT_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, s)
}

// Versions: GET /fleet/versions?image=server|keeper lists Docker Hub tags.
func (fc *FleetController) Versions(c *gin.Context) {
	repo := model.DefaultClickHouseImage
	if c.Query("image") == "keeper" {
		repo = model.DefaultKeeperImage
	}
	tags, err := fleet.ImageVersions(repo)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_SELECT_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, tags)
}

// PlanCluster: POST /fleet/clusters/plan checks a placement without deploying.
func (fc *FleetController) PlanCluster(c *gin.Context) {
	var req fleetdeploy.ClusterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	plan, _ := fleetdeploy.MakePlan(req)
	fc.wrapfunc(c, model.E_SUCCESS, plan)
}

// CreateCluster: POST /fleet/clusters deploys a cluster as containers.
func (fc *FleetController) CreateCluster(c *gin.Context) {
	var req fleetdeploy.ClusterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	taskID, plan, err := fleetdeploy.Create(req)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_CHECK_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, gin.H{"task_id": taskID, "plan": plan})
}

// ResizeCluster: PUT /fleet/cluster/:cluster/resources changes container
// limits live.
func (fc *FleetController) ResizeCluster(c *gin.Context) {
	var r fleetdeploy.Resources
	if err := c.ShouldBindJSON(&r); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	done, err := fleetdeploy.Resize(c.Param("cluster"), r)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_UPDATE_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, gin.H{"resized": done})
}

// ScaleKeepers: POST /fleet/cluster/:cluster/keepers adds Keepers on chosen
// machines and removes others (an odd number must remain); runs as a task.
func (fc *FleetController) ScaleKeepers(c *gin.Context) {
	var req fleetdeploy.KeeperChange
	if err := c.ShouldBindJSON(&req); err != nil {
		fc.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	taskID, err := fleetdeploy.ScaleKeepers(c.Param("cluster"), req)
	if err != nil {
		fc.wrapfunc(c, model.E_DATA_CHECK_FAILED, err)
		return
	}
	fc.wrapfunc(c, model.E_SUCCESS, gin.H{"task_id": taskID})
}
