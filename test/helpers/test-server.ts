/**
 * Test Server - Starts the NVR server in test mode
 */

import { Level } from 'level';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { initWeb } from '../../server/www.js';
import {
    initProcessor,
    runControlLoop,
    setShuttingDown,
    getMovementFFmpegProcesses,
    getMovementCloseHandlers,
    getMLDetectionProcess,
    resetProcessorState
} from '../../server/processor.js';
import { sseManager } from '../../server/sse-manager.js';
import { setLogger } from '../../server/process-utils.js';
import { setLogger as setSSELogger } from '../../server/sse-manager.js';
import { createMockCameraServer, MockCameraServer } from './mock-camera-server.js';
import { createTestSettings, createTestCamera } from './test-database.js';

import type {
    CameraEntry,
    CameraCache,
    CameraCacheEntry,
    Settings,
    SettingsCache,
    MovementEntry
} from '../../server/www.js';
import type { Server } from 'node:http';

interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

const createTestLogger = (): Logger => ({
    debug: (...args: any[]) => process.env.TEST_DEBUG && console.log('[DEBUG]', ...args),
    info: (...args: any[]) => process.env.TEST_DEBUG && console.log('[INFO]', ...args),
    warn: (...args: any[]) => console.warn('[WARN]', ...args),
    error: (...args: any[]) => console.error('[ERROR]', ...args)
});

export interface TestServerConfig {
    cameraCount?: number;
    enableDetection?: boolean;
    modelPath?: string;
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
    db: { base: Level<string, any>; cameras: any; movements: any; settings: any; };
    mockCameras: Map<string, MockCameraServer>;
    testDataDir: string;
    cameraCache: CameraCache;
    settingsCache: SettingsCache;
    runControlLoop: () => Promise<void>;
    setCameraMovement: (cameraKey: string, hasMovement: boolean) => void;
    waitForMovementState: (movementKey: string, state: string, timeoutMs?: number) => Promise<MovementEntry>;
    getMovements: () => Promise<MovementEntry[]>;
    shutdown: () => Promise<void>;
}

export async function startTestServer(config: TestServerConfig = {}): Promise<TestServer> {
    const {
        cameraCount = 1,
        enableDetection = false,
        modelPath = path.join(process.cwd(), 'ai/model/yolo11n.onnx'),
        controlLoopInterval = 0,
        port = 0
    } = config;

    const testId = `nvr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testDataDir = path.join(os.tmpdir(), testId);
    const dbPath = path.join(testDataDir, 'db');
    
    await fs.mkdir(testDataDir, { recursive: true });
    await fs.mkdir(dbPath, { recursive: true });

    const logger = createTestLogger();
    setLogger(logger as any);
    setSSELogger(logger as any);
    
    // Reset processor state to ensure test isolation
    resetProcessorState();

    const db = new Level(dbPath, { valueEncoding: 'json' });
    const cameradb = db.sublevel<string, CameraEntry>('cameras', { valueEncoding: 'json' });
    const movementdb = db.sublevel<string, MovementEntry>('movements', { valueEncoding: 'json' });
    const settingsdb = db.sublevel<string, Settings>('settings', { valueEncoding: 'json' });

    const mockCameras = new Map<string, MockCameraServer>();
    const cameraCache: CameraCache = {};

    for (let i = 0; i < cameraCount; i++) {
        const cameraKey = `camera-${i + 1}`;
        const cameraFolder = `cam${i + 1}`;
        const cameraDir = path.join(testDataDir, cameraFolder);
        
        await fs.mkdir(cameraDir, { recursive: true });
        await fs.mkdir(path.join(testDataDir, 'frames'), { recursive: true });
        await setupTestVideoFiles(cameraDir);

        const mockCamera = await createMockCameraServer({ movementState: 0 });
        mockCameras.set(cameraKey, mockCamera);

        const cameraEntry = createTestCamera({
            name: `Test Camera ${i + 1}`,
            folder: cameraFolder,
            disk: testDataDir,
            motionUrl: mockCamera.url,
            mSPollFrequency: 500,
            enable_streaming: true  // Enable streaming so controllerFFmpeg doesn't kill the mock task
        });

        await cameradb.put(cameraKey, cameraEntry);
        
        cameraCache[cameraKey] = {
            cameraEntry,
            ffmpeg_task: createMockFfmpegTask(i) as any,
            streamStartedAt: Date.now() - 60000
        };
    }

    const settings = createTestSettings({
        disk_base_dir: testDataDir,
        detection_model: enableDetection ? modelPath : '',
        detection_enable: enableDetection
    });
    await settingsdb.put('config', settings);

    let settingsCache: SettingsCache = {
        settings,
        status: { fail: false, nextCheckInMinutes: 0 }
    };

    if (config.movements) {
        for (const mov of config.movements) {
            const key = mov.startDate.toString().padStart(12, '0');
            await movementdb.put(key, {
                cameraKey: mov.cameraKey,
                startDate: mov.startDate,
                startSegment: null,
                seconds: 0,
                pollCount: 0,
                consecutivePollsWithoutMovement: 0,
                processing_state: mov.processing_state
            } as any);
        }
    }

    // State accessors
    const getCameraCache = () => cameraCache;
    const setCameraCache = (key: string, entry: CameraCacheEntry) => { cameraCache[key] = entry; };
    const getSettingsCache = () => settingsCache;
    const setSettingsCache = (cache: SettingsCache) => { settingsCache = cache; };

    initProcessor({
        logger: logger as any,
        cameradb,
        movementdb,
        settingsdb,
        getCameraCache,
        setCameraCache,
        getSettingsCache,
        setSettingsCache
    });

    const httpServer: Server = await initWeb({
        logger: logger as any,
        cameradb,
        movementdb,
        settingsdb,
        cameraCache,
        settingsCache,
        setSettingsCache
    }, port);

    const actualPort = (httpServer.address() as any).port;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    let controlLoopHandle: NodeJS.Timeout | null = null;
    if (controlLoopInterval > 0) {
        controlLoopHandle = setInterval(() => runControlLoop().catch(() => {}), controlLoopInterval);
    }

    let isShutdown = false;

    const testServer: TestServer = {
        port: actualPort,
        baseUrl,
        db: { base: db, cameras: cameradb, movements: movementdb, settings: settingsdb },
        mockCameras,
        testDataDir,
        cameraCache,
        get settingsCache() { return settingsCache; },

        runControlLoop: async () => { await runControlLoop(); },

        setCameraMovement: (cameraKey: string, hasMovement: boolean) => {
            const mockCamera = mockCameras.get(cameraKey);
            if (mockCamera) mockCamera.setState({ movementState: hasMovement ? 1 : 0 });
        },

        waitForMovementState: async (movementKey: string, state: string, timeoutMs = 30000): Promise<MovementEntry> => {
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                try {
                    const movement = await movementdb.get(movementKey);
                    if (movement && movement.processing_state === state) return movement;
                } catch { /* not found */ }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`Timeout waiting for movement ${movementKey} to reach state ${state}`);
        },

        getMovements: async (): Promise<MovementEntry[]> => {
            const movements: MovementEntry[] = [];
            for await (const [, value] of movementdb.iterator()) movements.push(value);
            return movements;
        },

        shutdown: async () => {
            if (isShutdown) return;
            isShutdown = true;
            setShuttingDown(true);

            if (controlLoopHandle) clearInterval(controlLoopHandle);

            // Kill movement ffmpeg processes
            for (const [key, ffmpeg] of getMovementFFmpegProcesses().entries()) {
                if (ffmpeg?.exitCode === null) {
                    await new Promise<void>(resolve => {
                        const timeout = setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} setTimeout(resolve, 100); }, 500);
                        ffmpeg.once('close', () => { clearTimeout(timeout); resolve(); });
                        try { ffmpeg.kill(); } catch { clearTimeout(timeout); resolve(); }
                    });
                }
            }

            // Kill camera ffmpeg processes
            for (const cameraKey of Object.keys(cameraCache)) {
                const { ffmpeg_task, cameraEntry } = cameraCache[cameraKey] || {};
                if (ffmpeg_task?.exitCode === null) {
                    await new Promise<void>(resolve => {
                        const timeout = setTimeout(() => {
                            logger.warn('ffmpeg process did not terminate in time - forcing', { camera: cameraEntry?.name, pid: ffmpeg_task.pid });
                            try { ffmpeg_task.kill('SIGKILL'); } catch {}
                            resolve();
                        }, 500);
                        ffmpeg_task.once('close', () => { clearTimeout(timeout); resolve(); });
                        try { ffmpeg_task.kill(); } catch { clearTimeout(timeout); resolve(); }
                    });
                }
            }

            // Kill ML process
            const mlProcess = getMLDetectionProcess();
            if (mlProcess?.exitCode === null) {
                await new Promise<void>(resolve => {
                    const timeout = setTimeout(() => { try { mlProcess.kill('SIGKILL'); } catch {} resolve(); }, 500);
                    mlProcess.once('close', () => { clearTimeout(timeout); resolve(); });
                    try { mlProcess.kill(); } catch { clearTimeout(timeout); resolve(); }
                });
            }

            // Wait for close handlers
            const closeHandlers = getMovementCloseHandlers();
            if (closeHandlers.size > 0) {
                await Promise.all(closeHandlers.values()).catch(() => {});
            }

            sseManager.closeAll();
            
            if (httpServer.listening) {
                await new Promise<void>(r => httpServer.close(() => r()));
            }

            await db.close().catch(() => {});
            setShuttingDown(false);

            for (const [, mockCamera] of mockCameras) await mockCamera.close();
            await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
        }
    };

    return testServer;
}

async function setupTestVideoFiles(cameraDir: string): Promise<void> {
    const testVideoDir = path.join(process.cwd(), 'test/data/video');
    try {
        const files = await fs.readdir(testVideoDir);
        for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
                const src = path.join(testVideoDir, file);
                const destName = file === 'test.m3u8' ? 'stream.m3u8' : file;
                await fs.copyFile(src, path.join(cameraDir, destName));
            }
        }
        const playlistPath = path.join(cameraDir, 'stream.m3u8');
        let playlist = await fs.readFile(playlistPath, 'utf-8');
        playlist = playlist.replace(/\/[^\n]*\//g, `${cameraDir}/`);
        await fs.writeFile(playlistPath, playlist);
    } catch {
        const playlistContent = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.0,\n${cameraDir}/stream100.ts\n`;
        await fs.writeFile(path.join(cameraDir, 'stream.m3u8'), playlistContent);
        await fs.writeFile(path.join(cameraDir, 'stream100.ts'), 'dummy');
    }
}

function createMockFfmpegTask(index: number) {
    const listeners: { [event: string]: Function[] } = {};
    return {
        exitCode: null as number | null,
        pid: 99999 + index,
        kill: function() {
            this.exitCode = 0;
            // Emit close event asynchronously
            setTimeout(() => {
                (listeners['close'] || []).forEach(fn => fn(0, null));
            }, 10);
        },
        once: function(event: string, fn: Function) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        on: function(event: string, fn: Function) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        stdout: { on: () => {} },
        stderr: { on: () => {} }
    };
}
