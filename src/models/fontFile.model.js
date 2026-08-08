const { DataTypes } = require('sequelize');

// One physical file of a family: a (weight, style, format) variant. A family is
// not a file — real typography needs at least regular and bold, often italics,
// and the browser wants woff2 where a server-side renderer may want ttf.
module.exports = (sequelize) => {
  const FontFile = sequelize.define('FontFile', {
    id:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    font_id: { type: DataTypes.INTEGER, allowNull: false },
    weight:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 400 },   // 100-900
    style:   { type: DataTypes.ENUM('normal', 'italic'), allowNull: false, defaultValue: 'normal' },
    format:  { type: DataTypes.ENUM('woff2', 'woff', 'ttf', 'otf'), allowNull: false },
    s3_key:  { type: DataTypes.STRING(500), allowNull: false },
  }, { tableName: 'font_files', timestamps: false });

  FontFile.associate = (models) => {
    FontFile.belongsTo(models.Font, { foreignKey: 'font_id' });
  };

  return FontFile;
};
