/**
 * Test Server - Thin wrapper around createServer() for tests
 * 
 * Uses the real server with test configuration:
 * - Temp database directory
 * - Test video file as stream source
 * - Mock motion API servers
 * - Short timeouts for fast tests
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { createServer, ServerHandle } from '../../server/index.js';
import { createMockCameraServer, MockCameraServer } from './mock-camera-server.js';

import type { CameraEntry, Settings, MovementEntry, CameraCache } from '../../server/www.js';

// ============================================================================
// Test Logger (quiet unless TEST_DEBUG=1)
// ============================================================================

const createTestLogger = () => ({
    debug: (...args: any[]) => process.env['TEST_DEBUG'] && console.log('[DEBUG]', ...args),
    info: (...args: any[]) => process.env['TEST_DEBUG'] && console.log('[INFO]', ...args),
    warn: (...args: any[]) => console.warn('[WARN]', ...args),
    error: (...args: any[]) => console.error('[ERROR]', ...args)
});

// ============================================================================
// Test Server Interface
// ============================================================================

export interface TestServerConfig {
    cameraCount?: number;
    enableDetection?: boolean;
    modelPath?: string;
    testVideoPath?: string;
    streamVerifyTimeoutMs?: number;
    controlLoopInterval?: number;
    port?: number;
    movements?: Array<{
        cameraKey: string;
        startDate: number;
        processing_state: 'pending' | 'processing' | 'completed' | 'failed';
    }>;
}

export interface TestServer {
    port: number;
    baseUrl: string;
    db: ServerHandle['db'];
    mockCameras: Map<string, MockCameraServer>;
    testDataDir: string;
    cameraCache: CameraCache;
    settingsCache: ReturnType<ServerHandle['getSettingsCache']>;
    runControlLoop: () => Promise<void>;
    getCameraKey: (index: number) => string;
    setCameraMovement: (cameraKeyOrIndex: string | number, hasMovement: boolean) => void;
    waitForMovementState: (movementKey: string, state: string, timeoutMs?: number) => Promise<MovementEntry>;
    getMovements: () => Promise<MovementEntry[]>;
    shutdown: () => Promise<void>;
}

// ============================================================================
// Start Test Server
// ============================================================================

export async function startTestServer(config: TestServerConfig = {}): Promise<TestServer> {
    const {
        cameraCount = 1,
        enableDetection = false,
        modelPath = path.join(process.cwd(), 'ai/model/yolo11n.onnx'),
        testVideoPath: customVideoPath,
        streamVerifyTimeoutMs = 2000,
        controlLoopInterval = 0,
        port = 0
    } = config;

    // Create temp directories
    const testId = `nvr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testDataDir = path.join(os.tmpdir(), testId);
    const dbPath = path.join(testDataDir, 'db');
    
    await fs.mkdir(testDataDir, { recursive: true });
    await fs.mkdir(dbPath, { recursive: true });

    // Find test video file (for stream source)
    const testVideoPath = customVideoPath || path.join(process.cwd(), 'test/data/video/test.mp4');
    const testVideoExists = await fs.access(testVideoPath).then(() => true).catch(() => false);

    // Create mock camera servers and camera configs
    const mockCameras = new Map<string, MockCameraServer>();
    const cameraConfigs: Array<{ key: string; entry: CameraEntry }> = [];

    for (let i = 0; i < cameraCount; i++) {
        const cameraKey = `camera-${i + 1}`;
        const cameraFolder = `cam${i + 1}`;
        const cameraDir = path.join(testDataDir, cameraFolder);
        
        await fs.mkdir(cameraDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, 'frames'), { recursive: true });
        await setupTestVideoFiles(cameraDir);

        // Create mock camera server for motion API
        const mockCamera = await createMockCameraServer({ movementState: 0 });
        mockCameras.set(cameraKey, mockCamera);

        cameraConfigs.push({
            key: cameraKey,
            entry: {
                delete: false,
                name: `Test Camera ${i + 1}`,
                folder: cameraFolder,
                disk: testDataDir,
                motionUrl: mockCamera.url,
                streamSource: testVideoExists ? testVideoPath : undefined,
                enable_streaming: true,
                enable_movement: true,
                pollsWithoutMovement: 3,
                secMaxSingleMovement: 300,
                mSPollFrequency: 500,
                segments_prior_to_movement: 2,
                segments_post_movement: 2,
                secMovementStartupDelay: 0
            }
        });
    }

    // Create the server with empty database
    const server = await createServer({
        dbPath,
        port,
        logger: createTestLogger(),
        controlLoopInterval,
        diskCleanupInterval: 0,
        registerSignalHandlers: false
    });

    // Use API to create settings
    const settings: Settings = {
        disk_base_dir: testDataDir,
        detection_model: enableDetection ? modelPath : '',
        detection_target_hw: 'cpu',
        detection_frames_path: 'frames',
        detection_enable: enableDetection,
        detection_tag_filters: [],
        disk_cleanup_interval: 0,
        disk_cleanup_capacity: 90,
        shutdown_timeout_ms: 500,
        stream_verify_timeout_ms: streamVerifyTimeoutMs
    };
    await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    });

    // Use API to create cameras and map mock cameras to server keys
    const cameraKeyMap = new Map<string, string>();  // testKey -> serverKey
    
    for (let i = 0; i < cameraConfigs.length; i++) {
        const { key: testKey, entry } = cameraConfigs[i];
        const beforeKeys = new Set(Object.keys(server.cameraCache));
        
        const response = await fetch(`http://127.0.0.1:${server.port}/api/camera/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry)
        });
        
        if (!response.ok) {
            throw new Error(`Failed to create camera: ${response.status} ${await response.text()}`);
        }
        
        // Find the newly created camera key
        const afterKeys = Object.keys(server.cameraCache);
        const serverKey = afterKeys.find(k => !beforeKeys.has(k)) || testKey;
        cameraKeyMap.set(testKey, serverKey);
        
        // Re-map mock camera to server key
        const mockCamera = mockCameras.get(testKey);
        if (mockCamera) {
            mockCameras.delete(testKey);
            mockCameras.set(serverKey, mockCamera);
        }
        
        // Ensure unique timestamps for next camera (server uses seconds-based keys)
        // Only wait if there are more cameras to create
        if (i < cameraConfigs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1100));
        }
        
        // Update cache with stream state
        if (server.cameraCache[serverKey]) {
            server.cameraCache[serverKey].streamStartedAt = Date.now() - 60000;
        }
    }

    // Add test movements via direct DB (movements aren't created via API)
    if (config.movements) {
        for (const mov of config.movements) {
            const key = mov.startDate.toString().padStart(12, '0');
            await server.db.movements.put(key, {
                cameraKey: mov.cameraKey,
                startDate: mov.startDate,
                startSegment: null,
                seconds: 0,
                pollCount: 0,
                consecutivePollsWithoutMovement: 0,
                processing_state: mov.processing_state
            } as MovementEntry);
        }
    }

    // Return test server interface
    return {
        port: server.port,
        baseUrl: server.baseUrl,
        db: server.db,
        mockCameras,
        testDataDir,
        cameraCache: server.cameraCache,
        get settingsCache() { return server.getSettingsCache(); },

        runControlLoop: server.runControlLoop,

        // Helper to get camera key by index (e.g., 1 -> first camera's server key)
        getCameraKey: (index: number): string => {
            const keys = Object.keys(server.cameraCache);
            return keys[index - 1] || `camera-${index}`;
        },

        setCameraMovement: (cameraKeyOrIndex: string | number, hasMovement: boolean) => {
            // Support both index (1, 2) and key lookup
            let cameraKey: string;
            if (typeof cameraKeyOrIndex === 'number') {
                cameraKey = Object.keys(server.cameraCache)[cameraKeyOrIndex - 1];
            } else {
                cameraKey = cameraKeyOrIndex;
            }
            const mockCamera = mockCameras.get(cameraKey);
            if (mockCamera) mockCamera.setState({ movementState: hasMovement ? 1 : 0 });
        },

        waitForMovementState: async (movementKey: string, state: string, timeoutMs = 30000): Promise<MovementEntry> => {
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                try {
                    const movement = await server.db.movements.get(movementKey) as MovementEntry;
                    if (movement && movement.processing_state === state) return movement;
                } catch { /* not found */ }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`Timeout waiting for movement ${movementKey} to reach state ${state}`);
        },

        getMovements: async (): Promise<MovementEntry[]> => {
            const movements: MovementEntry[] = [];
            for await (const [, value] of server.db.movements.iterator()) movements.push(value as MovementEntry);
            return movements;
        },

        shutdown: async () => {
            await server.shutdown();
            
            // Cleanup mock cameras
            for (const [, mockCamera] of mockCameras) {
                await mockCamera.close();
            }
            
            // Cleanup temp directory
            await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
        }
    };
}

// ============================================================================
// Helper: Setup test video files
// ============================================================================

async function setupTestVideoFiles(cameraDir: string): Promise<void> {
    const testVideoPath = path.join(process.cwd(), 'test/data/video/test.mp4');
    try {
        // Copy the mp4 file to camera directory
        const destPath = path.join(cameraDir, 'test.mp4');
        await fs.copyFile(testVideoPath, destPath);
        
        // Also create an HLS playlist that references the mp4 for live streaming tests
        // This is a minimal playlist that ffmpeg can read
        const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:90
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:90.0,
${destPath}
#EXT-X-ENDLIST
`;
        await fs.writeFile(path.join(cameraDir, 'stream.m3u8'), playlistContent);
    } catch {
        // Create minimal placeholder if test video doesn't exist
        await fs.writeFile(path.join(cameraDir, 'test.mp4'), 'dummy');
        const playlistContent = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n`;
        await fs.writeFile(path.join(cameraDir, 'stream.m3u8'), playlistContent);
    }
}

// ============================================================================
// Helper: Check file exists
// ============================================================================

export async function checkFileExists(relativePath: string): Promise<boolean> {
    const fullPath = path.join(process.cwd(), relativePath);
    return fs.access(fullPath).then(() => true).catch(() => false);
}
