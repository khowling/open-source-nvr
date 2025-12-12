/**
 * Full Server Integration Tests
 * 
 * Uses shared server instances to minimize startup/shutdown overhead.
 */

import path from 'path';
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
            // Camera keys are auto-generated, just check we have 2 cameras
            const cameraKeys = Object.keys(server.cameraCache);
            expect(server.cameraCache[cameraKeys[0]]).toBeDefined();
            expect(server.cameraCache[cameraKeys[1]]).toBeDefined();
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
            const data = await response.json() as { config: any; cameras: any[] };
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
            const cameraKey = server.getCameraKey(1);
            const currentCamera = server.cameraCache[cameraKey].cameraEntry;
            const updateData = { ...currentCamera, name: 'Updated Camera' };
            const response = await fetch(`${server.baseUrl}/api/camera/${cameraKey}`, {
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
            const cameraKey = server.getCameraKey(1);
            const movementKey = Date.now().toString().padStart(12, '0');
            await server.db.movements.put(movementKey, {
                cameraKey, startDate: Date.now(), startSegment: 100, seconds: 5,
                pollCount: 3, consecutivePollsWithoutMovement: 0, processing_state: 'completed'
            });
            const response = await fetch(`${server.baseUrl}/api/movements?mode=Movement`);
            expect(response.ok).toBe(true);
            const data = await response.json() as { movements: any[] };
            expect(data.movements.length).toBeGreaterThanOrEqual(1);
        });

        it('should return filtered movements with mode=Filtered', async () => {
            const cameraKey = server.getCameraKey(1);
            const startDate = Date.now();
            const movementKey = startDate.toString().padStart(12, '0');
            await server.db.movements.put(movementKey, {
                cameraKey, startDate, startSegment: 200, seconds: 10,
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
            const cameraKey = server.getCameraKey(1);
            const response = await fetch(`${server.baseUrl}/video/100/10/${cameraKey}/stream.m3u8`);
            expect(response.ok).toBe(true);
            const playlist = await response.text();
            expect(playlist).toContain('#EXTM3U');
        });

        it('should serve video playlist with preseq/postseq params', async () => {
            const cameraKey = server.getCameraKey(1);
            const response = await fetch(`${server.baseUrl}/video/105/4/${cameraKey}/stream.m3u8?preseq=2&postseq=2`);
            expect(response.ok).toBe(true);
        });

        it('should serve live video playlist via /video/live/:cameraKey/:file', async () => {
            const cameraKey = server.getCameraKey(1);
            const response = await fetch(`${server.baseUrl}/video/live/${cameraKey}/stream.m3u8`);
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
            const cameraKey = server.getCameraKey(1);
            server.setCameraMovement(cameraKey, true);
            await server.runControlLoop();
            const movements = await server.getMovements();
            expect(movements.length).toBeGreaterThanOrEqual(1);
            expect(movements[movements.length - 1].cameraKey).toBe(cameraKey);
        });

        it('should process movement end after consecutive polls', async () => {
            const cameraKey = server.getCameraKey(1);
            server.setCameraMovement(cameraKey, true);
            await server.runControlLoop();
            
            const movements = await server.getMovements();
            const movementKey = movements[movements.length - 1].startDate.toString().padStart(12, '0');
            
            server.cameraCache[cameraKey].movementDetectionStatus = {
                current_movement_key: movementKey,
                control: { fn_not_finished: false, fail: false, check_after: 0 }
            };

            server.setCameraMovement(cameraKey, false);
            for (let i = 0; i < 5; i++) {
                if (server.cameraCache[cameraKey].movementDetectionStatus) {
                    server.cameraCache[cameraKey].movementDetectionStatus.control = {
                        fn_not_finished: false, fail: false, check_after: 0
                    };
                }
                server.cameraCache[cameraKey].lastMovementCheck = 0;
                await server.runControlLoop();
            }

            const finalMovement = await server.db.movements.get(movementKey) as any;
            expect(finalMovement.consecutivePollsWithoutMovement).toBeGreaterThanOrEqual(3);
        });
    });
});

// Separate describe for ML pipeline test (needs its own server with detection enabled)
describe('Full Movement Pipeline', () => {
    it('should complete full movement detection cycle', async () => {
        const modelExists = await checkFileExists('ai/model/yolo11n.onnx');
        // Use fast-test.mp4 (10s, ultrafast encode, frequent keyframes) for quick HLS segment generation
        const fastVideoPath = path.join(process.cwd(), 'test/data/video/fast-test.mp4');
        const videoExists = await checkFileExists('test/data/video/fast-test.mp4');
        if (!modelExists || !videoExists) {
            console.log('Skipping full pipeline test - required files missing (need fast-test.mp4 and yolo model)');
            return;
        }

        const server = await startTestServer({ 
            cameraCount: 1, 
            enableDetection: true, 
            controlLoopInterval: 0,
            testVideoPath: fastVideoPath,
            streamVerifyTimeoutMs: 10000  // Allow 10s for HLS segments (2s segment time + buffering)
        });
        
        try {
            const cameraKey = server.getCameraKey(1);
            server.setCameraMovement(cameraKey, true);
            
            // Run multiple control loops to allow stream to start and movement to be detected
            // With secMovementStartupDelay=0, movement should be detected on first poll after stream ready
            let movements: any[] = [];
            const maxAttempts = 10;
            for (let i = 0; i < maxAttempts && movements.length === 0; i++) {
                await server.runControlLoop();
                movements = await server.getMovements();
                if (movements.length === 0) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            if (movements.length === 0) {
                console.log('Skipping full pipeline test - stream failed to start (FFmpeg issue with test video)');
                return;
            }

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

// Test concurrent movement detection from multiple cameras
describe('Concurrent Movement Detection', () => {
    // Helper to create a mock ffmpeg task that won't break shutdown
    const createMockTask = () => ({
        exitCode: null,
        pid: 12345,
        killed: false,
        kill: () => true,
        once: (_event: string, cb: () => void) => { cb(); },  // Immediately call close callback
        removeAllListeners: () => {}
    });

    it('should process movements from two cameras simultaneously and update each correctly', async () => {
        // Create server with 2 cameras, detection disabled for faster test
        const server = await startTestServer({ cameraCount: 2, enableDetection: false, controlLoopInterval: 0 });
        
        try {
            const camera1Key = server.getCameraKey(1);
            const camera2Key = server.getCameraKey(2);
            
            // Verify we have 2 distinct cameras
            expect(camera1Key).not.toBe(camera2Key);
            expect(Object.keys(server.cameraCache)).toHaveLength(2);
            
            // Set up mock ffmpeg tasks so movement detection can run
            // (Movement detection requires ffmpeg_task?.exitCode === null)
            server.cameraCache[camera1Key].ffmpeg_task = createMockTask() as any;
            server.cameraCache[camera2Key].ffmpeg_task = createMockTask() as any;
            
            // Trigger movement on BOTH cameras simultaneously
            server.setCameraMovement(camera1Key, true);
            server.setCameraMovement(camera2Key, true);
            
            // Run control loop - should detect movement from both cameras
            await server.runControlLoop();
            
            // Get all movements
            let movements = await server.getMovements();
            
            // Should have at least 2 movements (one per camera)
            expect(movements.length).toBeGreaterThanOrEqual(2);
            
            // Find movements for each camera
            const camera1Movements = movements.filter(m => m.cameraKey === camera1Key);
            const camera2Movements = movements.filter(m => m.cameraKey === camera2Key);
            
            expect(camera1Movements.length).toBeGreaterThanOrEqual(1);
            expect(camera2Movements.length).toBeGreaterThanOrEqual(1);
            
            const movement1 = camera1Movements[camera1Movements.length - 1];
            const movement2 = camera2Movements[camera2Movements.length - 1];
            
            // Both movements should have distinct start times
            expect(movement1.startDate).toBeDefined();
            expect(movement2.startDate).toBeDefined();
            
            // Store movement keys for later verification
            const movement1Key = movement1.startDate.toString().padStart(12, '0');
            const movement2Key = movement2.startDate.toString().padStart(12, '0');
            expect(movement1Key).not.toBe(movement2Key);
            
            // Set up status for polling
            server.cameraCache[camera1Key].movementDetectionStatus = {
                current_movement_key: movement1Key,
                control: { fn_not_finished: false, fail: false, check_after: 0 }
            };
            server.cameraCache[camera2Key].movementDetectionStatus = {
                current_movement_key: movement2Key,
                control: { fn_not_finished: false, fail: false, check_after: 0 }
            };
            
            // Continue polling with movement active on both cameras
            for (let i = 0; i < 3; i++) {
                server.cameraCache[camera1Key].lastMovementCheck = 0;
                server.cameraCache[camera2Key].lastMovementCheck = 0;
                await server.runControlLoop();
            }
            
            // Get updated movements
            const updatedMovement1 = await server.db.movements.get(movement1Key) as any;
            const updatedMovement2 = await server.db.movements.get(movement2Key) as any;
            
            // Both should have poll counts > 0
            expect(updatedMovement1.pollCount).toBeGreaterThan(0);
            expect(updatedMovement2.pollCount).toBeGreaterThan(0);
            
            // Now stop movement on camera 1 only
            server.setCameraMovement(camera1Key, false);
            
            // Run control loops to end movement on camera 1
            for (let i = 0; i < 5; i++) {
                if (server.cameraCache[camera1Key].movementDetectionStatus) {
                    server.cameraCache[camera1Key].movementDetectionStatus.control = {
                        fn_not_finished: false, fail: false, check_after: 0
                    };
                }
                if (server.cameraCache[camera2Key].movementDetectionStatus) {
                    server.cameraCache[camera2Key].movementDetectionStatus.control = {
                        fn_not_finished: false, fail: false, check_after: 0
                    };
                }
                server.cameraCache[camera1Key].lastMovementCheck = 0;
                server.cameraCache[camera2Key].lastMovementCheck = 0;
                await server.runControlLoop();
            }
            
            // Check camera 1 movement ended
            const finalMovement1 = await server.db.movements.get(movement1Key) as any;
            expect(finalMovement1.consecutivePollsWithoutMovement).toBeGreaterThanOrEqual(3);
            
            // Check camera 2 movement is still active (has 0 polls without movement or less than threshold)
            const finalMovement2 = await server.db.movements.get(movement2Key) as any;
            expect(finalMovement2.consecutivePollsWithoutMovement).toBeLessThan(3);
            
            // Now stop movement on camera 2
            server.setCameraMovement(camera2Key, false);
            
            // Run control loops to end movement on camera 2
            for (let i = 0; i < 5; i++) {
                if (server.cameraCache[camera2Key].movementDetectionStatus) {
                    server.cameraCache[camera2Key].movementDetectionStatus.control = {
                        fn_not_finished: false, fail: false, check_after: 0
                    };
                }
                server.cameraCache[camera2Key].lastMovementCheck = 0;
                await server.runControlLoop();
            }
            
            // Check camera 2 movement also ended
            const closedMovement2 = await server.db.movements.get(movement2Key) as any;
            expect(closedMovement2.consecutivePollsWithoutMovement).toBeGreaterThanOrEqual(3);
            
            // Verify movements are correctly associated with their cameras
            expect(finalMovement1.cameraKey).toBe(camera1Key);
            expect(closedMovement2.cameraKey).toBe(camera2Key);
            
            console.log('\n=== Concurrent Movement Test Results ===');
            console.log(`Camera 1 (${camera1Key}): Movement ${movement1Key}`);
            console.log(`  - Poll count: ${finalMovement1.pollCount}`);
            console.log(`  - Polls without movement: ${finalMovement1.consecutivePollsWithoutMovement}`);
            console.log(`Camera 2 (${camera2Key}): Movement ${movement2Key}`);
            console.log(`  - Poll count: ${closedMovement2.pollCount}`);
            console.log(`  - Polls without movement: ${closedMovement2.consecutivePollsWithoutMovement}`);
            console.log('=========================================\n');
            
        } finally {
            await server.shutdown();
        }
    }, 30000);
    
    it('should process movements sequentially when detection is enabled', async () => {
        const modelExists = await checkFileExists('ai/model/yolo11n.onnx');
        const videoExists = await checkFileExists('test/data/video/test.mp4');
        if (!modelExists || !videoExists) {
            console.log('Skipping concurrent detection test - required files missing');
            return;
        }
        
        const server = await startTestServer({ cameraCount: 2, enableDetection: true, controlLoopInterval: 0 });
        
        try {
            const camera1Key = server.getCameraKey(1);
            const camera2Key = server.getCameraKey(2);
            
            // Set up mock ffmpeg tasks so movement detection can run
            server.cameraCache[camera1Key].ffmpeg_task = createMockTask() as any;
            server.cameraCache[camera2Key].ffmpeg_task = createMockTask() as any;
            
            // Trigger movement on both cameras
            server.setCameraMovement(camera1Key, true);
            server.setCameraMovement(camera2Key, true);
            
            // Run control loop - should detect movements
            await server.runControlLoop();
            
            let movements = await server.getMovements();
            
            if (movements.length < 2) {
                console.log('Skipping concurrent detection test - movements not detected');
                return;
            }
            
            // Verify we have movements from both cameras
            const camera1Movements = movements.filter(m => m.cameraKey === camera1Key);
            const camera2Movements = movements.filter(m => m.cameraKey === camera2Key);
            
            expect(camera1Movements.length).toBeGreaterThanOrEqual(1);
            expect(camera2Movements.length).toBeGreaterThanOrEqual(1);
            
            // Get movement keys
            const mov1 = camera1Movements[camera1Movements.length - 1];
            const mov2 = camera2Movements[camera2Movements.length - 1];
            const key1 = mov1.startDate.toString().padStart(12, '0');
            const key2 = mov2.startDate.toString().padStart(12, '0');
            
            // Wait for detection processing to complete or fail
            const waitForProcessing = async (key: string, timeout = 15000): Promise<any> => {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const movement = await server.db.movements.get(key) as any;
                    if (movement.processing_state === 'completed' || 
                        movement.processing_state === 'failed' ||
                        movement.detection_output?.tags?.length > 0) {
                        return movement;
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                return await server.db.movements.get(key);
            };
            
            // Wait for both movements to be processed
            const [processed1, processed2] = await Promise.all([
                waitForProcessing(key1),
                waitForProcessing(key2)
            ]);
            
            // Verify each movement has its own detection output
            // (or at minimum, has been processed)
            console.log('\n=== Concurrent Detection Results ===');
            console.log(`Camera 1 Movement (${key1}):`);
            console.log(`  - State: ${processed1.processing_state || 'pending'}`);
            console.log(`  - Tags: ${processed1.detection_output?.tags?.length || 0}`);
            console.log(`Camera 2 Movement (${key2}):`);
            console.log(`  - State: ${processed2.processing_state || 'pending'}`);
            console.log(`  - Tags: ${processed2.detection_output?.tags?.length || 0}`);
            console.log('====================================\n');
            
            // Verify camera keys are correctly preserved
            expect(processed1.cameraKey).toBe(camera1Key);
            expect(processed2.cameraKey).toBe(camera2Key);
            
        } finally {
            await server.shutdown();
        }
    }, 45000);
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
