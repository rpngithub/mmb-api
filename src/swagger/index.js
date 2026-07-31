const swaggerJsdoc = require('swagger-jsdoc');
const modelSchemas = require('./modelSchemas');

const options = {
  definition: {
    openapi: '3.0.0',
    info: { title: 'MakeMyBrand API', version: '1.0.0', description: 'MakeMyBrand backend REST API' },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      // Model-derived response schemas (see src/swagger/modelSchemas.js + schemaConfig.js).
      schemas: modelSchemas,
    },
    security: [{ bearerAuth: [] }],
    servers: [{ url: '/api/v1' }],
  },
  apis: [
    './src/routes/*.js',
    './src/swagger/schemas/*.js',
  ],
};

module.exports = swaggerJsdoc(options);
