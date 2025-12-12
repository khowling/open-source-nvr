import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        testTimeout: 60000,
        hookTimeout: 30000,
        pool: 'forks', // Use separate processes for better isolation
        poolOptions: {
            forks: {
                singleFork: true // Run tests sequentially to avoid resource conflicts
            }
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'html'],
            include: ['server/**/*.ts'],
            exclude: [
                'server/**/*.test.ts',
                'server/index.old.ts'
            ],
            reportsDirectory: './coverage'
        }
    }
});
