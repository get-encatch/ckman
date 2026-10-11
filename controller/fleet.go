package controller

import (
	"github.com/gin-gonic/gin"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/fleet"
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
