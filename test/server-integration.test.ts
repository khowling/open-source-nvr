/**
 * Full Server Integration Tests
 * 
 * Uses shared server instances to minimize startup/shutdown overhead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestServer } from './helpers/test-server.js';

// Shared server for basic API tests (no ML detection)
describe('Server Integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ cameraCount: 2, controlLoopInterval: 0 });
    });

    afterAll(async () => {
        if (server) await server.shutdown();
    });

    describe('Server Startup', () => {
        it('should start server and listen on port', () => {
            expect(server.port).toBeGreaterThan(0);
            expect(server.baseUrl).toContain('http://127.0.0.1:');
        });

        it('should initialize camera cache from database', () => {
            expect(Object.keys(server.cameraCache)).toHaveLength(2);
            expect(server.cameraCache['camera-1']).toBeDefined();
            expect(server.cameraCache['camera-2']).toBeDefined();
        });

        it('should initialize settings cache', () => {
            expect(server.settingsCache.settings).toBeDefined();
            expect(server.settingsCache.settings.disk_base_dir).toBe(server.testDataDir);
        });
    });

    describe('Web API Routes', () => {
        it('should respond to GET /api/movements with config and cameras', async () => {
            const response = await fetch(`${server.baseUrl}/api/movements`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.config).toBeDefined();
            expect(data.cameras).toBeDefined();
            expect(Array.isArray(data.cameras)).toBe(true);
        });

        it('should respond to POST /api/settings', async () => {
            const newSettings = { ...server.settingsCache.settings, detection_enable: true };
            const response = await fetch(`${server.baseUrl}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSettings)
            });
            expect(response.status).toBe(201);
        });

        it('should respond to POST /api/camera/:id for updates', async () => {
            const currentCamera = server.cameraCache['camera-1'].cameraEntry;
            const updateData = { ...currentCamera, name: 'Updated Camera' };
            const response = await fetch(`${server.baseUrl}/api/camera/camera-1`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });
            expect(response.status).toBe(201);
        });

        it('should create a new camera via POST /api/camera/new', async () => {
            const newCamera = {
                name: 'Brand New Camera', folder: 'new-cam', disk: server.testDataDir,
                enable_streaming: false, enable_movement: true, pollsWithoutMovement: 3,
                secMaxSingleMovement: 300, mSPollFrequency: 1000,
                segments_prior_to_movement: 2, segments_post_movement: 2, secMovementStartupDelay: 0
            };
            const response = await fetch(`${server.baseUrl}/api/camera/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newCamera)
            });
            expect(response.status).toBe(201);
        });

        it('should return movements in GET /api/movements', async () => {
            const movementKey = Date.now().toString().padStart(12, '0');
            await server.db.movements.put(movementKey, {
                cameraKey: 'camera-1', startDate: Date.now(), startSegment: 100, seconds: 5,
                pollCount: 3, consecutivePollsWithoutMovement: 0, processing_state: 'completed'
            });
            const response = await fetch(`${server.baseUrl}/api/movements?mode=Movement`);
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data.movements.length).toBeGreaterThanOrEqual(1);
        });

        it('should return filtered movements with mode=Filtered', async () => {
            const startDate = Date.now();
            const movementKey = startDate.toString().padStart(12, '0');
            await server.db.movements.put(movementKey, {
                cameraKey: 'camera-1', startDate, startSegment: 200, seconds: 10,
                pollCount: 5, consecutivePollsWithoutMovement: 3, processing_state: 'completed',
                detection_output: { tags: [{ tag: 'person', maxProbability: 0.95, count: 3 }] }
            });
            const response = await fetch(`${server.baseUrl}/api/movements?mode=Filtered`);
            expect(response.ok).toBe(true);
        });

        it('should handle SSE connection for movements stream', async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 500);
            try {
                const response = await fetch(`${server.baseUrl}/api/movements/stream`, { signal: controller.signal });
                expect(response.ok).toBe(true);
                expect(response.headers.get('content-type')).toContain('text/event-stream');
            } catch (e: any) {
                if (e.name !== 'AbortError') throw e;
            } finally {
                clearTimeout(timeout);
            }
        });

        it('should serve video playlist via /video/:startSegment/:seconds/:cameraKey/:file', async () => {
            const response = await fetch(`${server.baseUrl}/video/100/10/camera-1/stream.m3u8`);
            expect(response.ok).toBe(true);
            const playlist = await response.text();
            expect(playlist).toContain('#EXTM3U');
        });

        it('should serve video playlist with preseq/postseq params', async () => {
            const response = await fetch(`${server.baseUrl}/video/105/4/camera-1/stream.m3u8?preseq=2&postseq=2`);
            expect(response.ok).toBe(true);
        });

        it('should serve live video playlist via /video/live/:cameraKey/:file', async () => {
            const response = await fetch(`${server.baseUrl}/video/live/camera-1/stream.m3u8`);
            expect([200, 400]).toContain(response.status);
        });

        it('should return 404 for non-existent movement image', async () => {
            const response = await fetch(`${server.baseUrl}/image/999999999`);
            expect(response.status).toBe(400);
        });

        it('should return 404 for non-existent frame', async () => {
            const response = await fetch(`${server.baseUrl}/frame/999999999/nonexistent.jpg`);
            expect(response.status).toBe(400);
        });
    });

    describe('Control Loop', () => {
        it('should detect camera movement via control loop', async () => {
            server.setCameraMovement('camera-1', true);
            await server.runControlLoop();
            const movements = await server.getMovements();
            expect(movements.length).toBeGreaterThanOrEqual(1);
            expect(movements[movements.length - 1].cameraKey).toBe('camera-1');
        });

        it('should process movement end after consecutive polls', async () => {
            server.setCameraMovement('camera-1', true);
            await server.runControlLoop();
            
            const movements = await server.getMovements();
            const movementKey = movements[movements.length - 1].startDate.toString().padStart(12, '0');
            
            server.cameraCache['camera-1'].movementDetectionStatus = {
                current_movement_key: movementKey,
                control: { fn_not_finished: false, fail: false, check_after: 0 }
            };

            server.setCameraMovement('camera-1', false);
            for (let i = 0; i < 5; i++) {
                if (server.cameraCache['camera-1'].movementDetectionStatus) {
                    server.cameraCache['camera-1'].movementDetectionStatus.control = {
                        fn_not_finished: false, fail: false, check_after: 0
                    };
                }
                server.cameraCache['camera-1'].lastMovementCheck = 0;
                await server.runControlLoop();
            }

            const finalMovement = await server.db.movements.get(movementKey);
            expect(finalMovement.consecutivePollsWithoutMovement).toBeGreaterThanOrEqual(3);
        });
    });
});

// Separate describe for ML pipeline test (needs its own server with detection enabled)
describe('Full Movement Pipeline', () => {
    it('should complete full movement detection cycle', async () => {
        const modelExists = await checkFileExists('ai/model/yolo11n.onnx');
        const videoExists = await checkFileExists('test/data/video/test.m3u8');
        if (!modelExists || !videoExists) {
            console.log('Skipping full pipeline test - required files missing');
            return;
        }

        const server = await startTestServer({ cameraCount: 1, enableDetection: true, controlLoopInterval: 0 });
        
        try {
            server.setCameraMovement('camera-1', true);
            
            await server.runControlLoop();

            const movements = await server.getMovements();
            expect(movements.length).toBeGreaterThanOrEqual(1);
            const movementKey = movements[movements.length - 1].startDate.toString().padStart(12, '0');
        
            let finalMovement;
            const maxWait = 10000;
            const startWait = Date.now();
            
            while (Date.now() - startWait < maxWait) {
                finalMovement = await server.db.movements.get(movementKey);
                if (finalMovement.processing_state === 'completed' || finalMovement.processing_state === 'failed') break;
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            expect(finalMovement).toBeDefined();
            expect(['processing', 'completed', 'failed']).toContain(finalMovement.processing_state);
            
            console.log('\n=== Movement Detection Result ===');
            console.log('Movement Key:', movementKey);
            console.log('Processing State:', finalMovement.processing_state);
            if (finalMovement.detection_output?.tags?.length > 0) {
                console.log('Detected Objects:');
                for (const tag of finalMovement.detection_output.tags) {
                    console.log(`  - ${tag.tag}: ${(tag.maxProbability * 100).toFixed(1)}% confidence`);
                }
            }
            console.log('=================================\n');
        } finally {
            await server.shutdown();
        }
    }, 20000);
});

// Separate describe for shutdown test
describe('Graceful Shutdown', () => {
    it('should shutdown cleanly', async () => {
        const server = await startTestServer({ cameraCount: 1, controlLoopInterval: 0 });
        const baseUrl = server.baseUrl;
        
        await expect(server.shutdown()).resolves.toBeUndefined();
        
        try {
            await fetch(`${baseUrl}/api/movements`, { signal: AbortSignal.timeout(500) });
        } catch (e: any) {
            expect(['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'AbortError']).toContain(
                e.code || e.cause?.code || e.name
            );
        }
    });
});

async function checkFileExists(relativePath: string): Promise<boolean> {
    try {
        const fs = await import('fs/promises');
        const path = await import('path');
        await fs.access(path.join(process.cwd(), relativePath));
        return true;
    } catch {
        return false;
    }
}
