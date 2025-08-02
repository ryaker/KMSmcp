/**
 * Jest test setup file
 */
// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.MEM0_API_KEY = 'test-mem0-key';
process.env.MONGODB_URI = 'mongodb://localhost:27017';
process.env.MONGODB_DATABASE = 'test_unified_kms';
process.env.NEO4J_URI = 'bolt://localhost:7687';
process.env.NEO4J_USERNAME = 'neo4j';
process.env.NEO4J_PASSWORD = 'test-password';
process.env.REDIS_URI = 'redis://localhost:6379';
// Increase timeout for integration tests
jest.setTimeout(10000);
// Mock console methods to reduce noise in tests
global.console = {
    ...console,
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};
// Global test utilities
global.testUtils = {
    createMockAuthContext: (overrides = {}) => ({
        isAuthenticated: true,
        user: {
            id: 'test-user',
            email: 'test@example.com',
            name: 'Test User',
            roles: ['user']
        },
        token: {
            type: 'Bearer',
            value: 'test-token',
            scope: 'mcp:read mcp:write'
        },
        ...overrides
    }),
    createMockOAuthConfig: (overrides = {}) => ({
        enabled: true,
        issuer: 'https://auth.example.com',
        audience: 'https://mcp.example.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        ...overrides
    }),
    createMockKMSConfig: (overrides = {}) => ({
        mongodb: {
            uri: process.env.MONGODB_URI,
            database: process.env.MONGODB_DATABASE
        },
        neo4j: {
            uri: process.env.NEO4J_URI,
            username: process.env.NEO4J_USERNAME,
            password: process.env.NEO4J_PASSWORD
        },
        mem0: {
            apiKey: process.env.MEM0_API_KEY,
            orgId: 'test-org'
        },
        redis: {
            uri: process.env.REDIS_URI
        },
        fact: {
            l1CacheSize: 10485760, // 10MB
            l2CacheTTL: 300000, // 5 minutes
            l3CacheTTL: 600000 // 10 minutes
        },
        transport: {
            mode: 'stdio'
        },
        ...overrides
    })
};
export {};
//# sourceMappingURL=setup.js.map