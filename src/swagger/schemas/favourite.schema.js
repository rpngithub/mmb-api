/**
 * Hand-written shapes for My Favourites. The lists reuse the public card shapes
 * (TemplatePublic, Asset) and add a total; the toggles return the new state.
 *
 * @swagger
 * components:
 *   schemas:
 *     FavouriteTemplateListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: array
 *           items: { $ref: '#/components/schemas/TemplatePublic' }
 *         meta:
 *           type: object
 *           properties:
 *             total: { type: integer, description: Saved designs the caller can currently open }
 *     FavouriteAssetListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: array
 *           items: { $ref: '#/components/schemas/Asset' }
 *         meta:
 *           type: object
 *           properties:
 *             total: { type: integer, description: Saved assets that are still active }
 *     FavouriteToggleResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             favourited:  { type: boolean, description: The state after the call }
 *             likes_count: { type: integer, description: "Templates only: the design's new favourites count, to update the card without a refetch" }
 */
