const { DataTypes } = require('sequelize');

// One row per scan run.
//
// The notification jobs run in-process on every API instance, so each console.log
// lands in a different container and there is otherwise no way to answer "did last
// night's dormancy scan actually run?". A scan that has been failing silently for a
// week is the realistic failure mode of this whole feature — nothing breaks, users
// just quietly stop hearing from us — and this table is what makes that visible.
//
// `skipped_locked` is the normal outcome on every instance but one. It is recorded
// rather than dropped so that "one instance ran and the rest stood down" is
// distinguishable from "nothing ran anywhere".
module.exports = (sequelize) => {
  const NotificationJobRun = sequelize.define('NotificationJobRun', {
    id:      { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    job_key: { type: DataTypes.STRING(60), allowNull: false },
    // hostname + pid — which instance won the advisory lock.
    instance: { type: DataTypes.STRING(100), allowNull: true },
    status: {
      type: DataTypes.ENUM('running', 'ok', 'failed', 'skipped_locked'),
      allowNull: false, defaultValue: 'running',
    },
    scanned_count:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    inserted_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    skipped_count:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error_message:  { type: DataTypes.TEXT, allowNull: true },
    started_at:     { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    finished_at:    { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'notification_job_runs',
    // `started_at` / `finished_at` are the timestamps that mean something here.
    timestamps: false,
  });

  return NotificationJobRun;
};
