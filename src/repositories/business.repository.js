const { Op, literal } = require('sequelize');
const BaseRepository = require('./base.repository');
const { Business, BusinessCategory } = require('../models');

const EARTH_KM = 6371;
const KM_PER_DEG_LAT = 111.045;

class BusinessRepository extends BaseRepository {
  constructor() { super(Business); }

  findAllByUser(userId) { return this.findMany({ user_id: userId, is_active: 1 }); }

  // Public profile: active businesses only, with their category for the label chip.
  findPublicByUid(uid) {
    return this.findOne(
      { uid, is_active: 1 },
      { include: [{ model: BusinessCategory, attributes: ['id', 'uid', 'slug', 'name'] }] },
    );
  }

  /**
   * "Near Me" geo search. Caller passes already-sanitized numbers.
   * Bounding-box prefilter (index-friendly) narrows rows, then a haversine
   * expression gives precise `distance_km` for the radius cut and ordering.
   */
  findNearby({ lat, lng, radiusKm, q, categoryId, sort, limit, offset }) {
    const latDelta = radiusKm / KM_PER_DEG_LAT;
    const lngDelta = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 1);

    const distance = literal(
      `(${EARTH_KM} * acos(LEAST(1, ` +
      `cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng})) + ` +
      `sin(radians(${lat})) * sin(radians(latitude)))))`,
    );

    const where = {
      is_active: 1,
      latitude:  { [Op.between]: [lat - latDelta, lat + latDelta] },
      longitude: { [Op.between]: [lng - lngDelta, lng + lngDelta] },
    };
    if (categoryId != null) where.category_id = categoryId; // 0 => supplied-but-unresolved: match nothing
    if (q) where[Op.or] = [
      { name:        { [Op.like]: `%${q}%` } },
      { description: { [Op.like]: `%${q}%` } },
    ];

    const order = sort === 'rating'
      ? [[literal('rating_avg'), 'DESC'], [literal('rating_count'), 'DESC'], [literal('distance_km'), 'ASC']]
      : [[literal('distance_km'), 'ASC']];

    return this.model.findAll({
      attributes: { include: [[distance, 'distance_km']] },
      where,
      having: literal(`distance_km <= ${radiusKm}`),
      include: [{ model: BusinessCategory, attributes: ['id', 'uid', 'slug', 'name'] }],
      order,
      limit,
      offset,
      subQuery: false,
    });
  }
}

module.exports = new BusinessRepository();
