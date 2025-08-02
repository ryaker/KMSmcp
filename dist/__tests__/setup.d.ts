/**
 * Jest test setup file
 */
declare global {
    var testUtils: {
        createMockAuthContext: (overrides?: any) => any;
        createMockOAuthConfig: (overrides?: any) => any;
        createMockKMSConfig: (overrides?: any) => any;
    };
}
export {};
//# sourceMappingURL=setup.d.ts.map