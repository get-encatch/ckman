package postgres

import (
	"time"

	"github.com/housepower/ckman/repository"
	"github.com/pkg/errors"
)

// TblFleetObject stores fleet objects (machines, standbys, settings) as JSON
// documents keyed by kind and id, so new fleet features need no new tables.
type TblFleetObject struct {
	Kind       string `gorm:"column:obj_kind;primaryKey;size:32"`
	ID         string `gorm:"column:obj_id;primaryKey;size:128"`
	Name       string `gorm:"column:obj_name;size:128"`
	Body       string `gorm:"column:obj_body"`
	UpdateTime string `gorm:"column:update_time;size:32"`
}

func (TblFleetObject) TableName() string { return "tbl_fleet_object" }

// PutFleetObject inserts or replaces one object.
func (mp *PostgresPersistent) PutFleetObject(kind, id, name string, body []byte) error {
	now := time.Now().Format("2006-01-02 15:04:05.999")
	tx := mp.Client.Model(&TblFleetObject{}).Where("obj_kind = ? AND obj_id = ?", kind, id).Updates(map[string]interface{}{
		"obj_name":    name,
		"obj_body":    string(body),
		"update_time": now,
	})
	if tx.Error != nil {
		return wrapError(tx.Error)
	}
	if tx.RowsAffected > 0 {
		return nil
	}
	return wrapError(mp.Client.Create(&TblFleetObject{Kind: kind, ID: id, Name: name, Body: string(body), UpdateTime: now}).Error)
}

func (mp *PostgresPersistent) GetFleetObject(kind, id string) ([]byte, error) {
	var tbl TblFleetObject
	if err := mp.Client.Where("obj_kind = ? AND obj_id = ?", kind, id).First(&tbl).Error; err != nil {
		return nil, wrapError(err)
	}
	return []byte(tbl.Body), nil
}

func (mp *PostgresPersistent) ListFleetObjects(kind string) ([][]byte, error) {
	var tbls []TblFleetObject
	if err := mp.Client.Where("obj_kind = ?", kind).Order("obj_name").Find(&tbls).Error; err != nil {
		return nil, wrapError(err)
	}
	out := make([][]byte, 0, len(tbls))
	for _, t := range tbls {
		out = append(out, []byte(t.Body))
	}
	return out, nil
}

func (mp *PostgresPersistent) DeleteFleetObject(kind, id string) error {
	tx := mp.Client.Where("obj_kind = ? AND obj_id = ?", kind, id).Delete(&TblFleetObject{})
	if tx.Error != nil {
		return errors.Wrap(tx.Error, "")
	}
	if tx.RowsAffected == 0 {
		return repository.ErrRecordNotFound
	}
	return nil
}
