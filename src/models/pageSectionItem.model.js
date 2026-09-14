const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PageSectionItem = sequelize.define('PageSectionItem', {
    id:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    section_id: { type: DataTypes.INTEGER, allowNull: false },
    // One shape for every list in the design: a chip fills `title` alone, a
    // feature card fills title + body + icon_s3_key.
    title:        { type: DataTypes.STRING(200), allowNull: true },
    body:         { type: DataTypes.TEXT, allowNull: true },
    icon_s3_key:  { type: DataTypes.STRING(500), allowNull: true },
    link_url:     { type: DataTypes.STRING(500), allowNull: true },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'page_section_items' });

  PageSectionItem.associate = (models) => {
    PageSectionItem.belongsTo(models.PageSection, { as: 'section', foreignKey: 'section_id' });
  };

  return PageSectionItem;
};
