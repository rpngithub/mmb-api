const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('AppBanner', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    title:           { type: DataTypes.STRING(200), allowNull: false },
    message:         { type: DataTypes.TEXT, allowNull: false },
    cta_label:       { type: DataTypes.STRING(100), allowNull: true },
    cta_url:         { type: DataTypes.STRING(500), allowNull: true },
    banner_type:     { type: DataTypes.ENUM('info', 'warning', 'promo', 'maintenance'), defaultValue: 'info' },
    target_audience: { type: DataTypes.ENUM('all', 'free_users', 'paid_users'), defaultValue: 'all' },
    starts_at:       { type: DataTypes.DATE, allowNull: false },
    ends_at:         { type: DataTypes.DATE, allowNull: true },
    is_dismissible:  { type: DataTypes.TINYINT, defaultValue: 1 },
    status:          { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  }, { tableName: 'app_banners' });
};
