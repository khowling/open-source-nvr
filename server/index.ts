/**
 * Main entry point for the NVR Server
 * 
 * This file serves as the application bootstrap, wiring together:
 * - Database connections (cameradb, settingsdb, movementdb)
 * - Web server (www.ts)
 * - Control loop processor (processor.ts)
 * - Graceful shutdown handling
 * 
 * Per requirements: Minimal boilerplate, state in database for persistence
 * 
 * Exports createServer() for programmatic use (e.g., tests)
 */

import { Level } from 'level';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { logger as defaultLogger } from './logger.js';
import { initWeb } from './www.js';
import {
    initProcessor,
    runControlLoop,
    runDiskCleanupLoop,
    setShuttingDown,
    isShuttingDown,
    getMLDetectionProcess,
    getMovementFFmpegProcesses,
    getMovementCloseHandlers,
    resetProcessorState
} from './processor.js';
import { sseManager } from './sse-manager.js';
import { setLogger } from './process-utils.js';
import { setLogger as setSSELogger } from './sse-manager.js';

import type { CameraEntry, CameraCache, CameraCacheEntry, Settings, SettingsCache, MovementEntry, DiskStatusEntry } from './www.js';

// ============================================================================
// Server Configuration
// ============================================================================

export interface ServerConfig {
    /** Database path (default: ./mydb or DBPATH env var) */
    dbPath?: string;
    /** HTTP port (default: 8080 or PORT env var) */
    port?: number;
    /** Custom logger (default: winston logger from logger.ts) */
    logger?: {
        debug: (...args: any[]) => void;
        info: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
    /** Control loop interval in ms (default: 1000, set 0 to disable auto-run) */
    controlLoopInterval?: number;
    /** Disk cleanup loop interval in ms (default: 60000, set 0 to disable) */
    diskCleanupInterval?: number;
    /** Register process signal handlers (default: true, set false for tests) */
    registerSignalHandlers?: boolean;
}

export interface ServerHandle {
    /** HTTP port the server is listening on */
    port: number;
    /** Base URL for HTTP requests */
    baseUrl: string;
    /** Database handles */
    db: {
        base: Level<string, any>;
        cameras: ReturnType<Level<string, any>['sublevel']>;
        movements: ReturnType<Level<string, any>['sublevel']>;
        settings: ReturnType<Level<string, any>['sublevel']>;
    };
    /** In-memory camera cache (live reference) */
    cameraCache: CameraCache;
    /** In-memory settings cache (live getter) */
    getSettingsCache: () => SettingsCache;
    /** Manually run the control loop */
    runControlLoop: () => Promise<void>;
    /** Graceful shutdown */
    shutdown: () => Promise<void>;
}

// ============================================================================
// Create Server
// ============================================================================

export async function createServer(config: ServerConfig = {}): Promise<ServerHandle> {
    const {
        dbPath = process.env['DBPATH'] || './mydb',
        port = parseInt(process.env['PORT'] || '8080'),
        logger = defaultLogger,
        controlLoopInterval = 1000,
        diskCleanupInterval = 60000,
        registerSignalHandlers = true
    } = config;

    // Initialize utilities with logger
    setLogger(logger);
    setSSELogger(logger);
    
    // Reset processor state (important for tests that create multiple servers)
    resetProcessorState();

    // Database Setup
    const db = new Level(dbPath, { valueEncoding: 'json' });
    await db.open(); // Ensure database is fully opened before using iterators
    const cameradb = db.sublevel<string, CameraEntry>('cameras', { valueEncoding: 'json' });
    const movementdb = db.sublevel<string, MovementEntry>('movements', { valueEncoding: 'json' });
    const settingsdb = db.sublevel<string, Settings>('settings', { valueEncoding: 'json' });
    const diskstatusdb = db.sublevel<string, DiskStatusEntry>('diskstatus', { valueEncoding: 'json' });

    // In-Memory State
    let _inmem_cameraCache: CameraCache = {};
    let _inmem_settingsCache: SettingsCache;

    // State Accessors
    const getCameraCache = () => _inmem_cameraCache;
    const setCameraCache = (key: string, entry: CameraCacheEntry) => { _inmem_cameraCache[key] = entry; };
    const getSettingsCache = () => _inmem_settingsCache;
    const setSettingsCache = (cache: SettingsCache) => { _inmem_settingsCache = cache; };

    // Populate cameraCache from database
    for await (const [key, value] of cameradb.iterator()) {
        _inmem_cameraCache[key] = { cameraEntry: value };
    }

    // Populate settingsCache with defaults
    _inmem_settingsCache = {
        settings: {
            disk_base_dir: '',
            detection_model: '',
            detection_target_hw: '',
            detection_frames_path: '',
            detection_enable: false,
            detection_tag_filters: [],
            disk_cleanup_interval: 0,
            disk_cleanup_capacity: 90
        },
        status: {
            fail: false,
            nextCheckInMinutes: 0
        }
    };

    // Load saved settings
    try {
        const savedSettings = await settingsdb.get('config');
        if (savedSettings) {
            _inmem_settingsCache = { ..._inmem_settingsCache, settings: savedSettings };
        }
    } catch {
        logger.info('No saved settings found, using defaults');
    }

    // Recovery: Reset any movements stuck in 'processing' state back to 'pending'
    // This handles server restarts mid-processing
    let stuckCount = 0;
    for await (const [key, movement] of movementdb.iterator()) {
        if (movement.processing_state === 'processing') {
            logger.warn('Recovering stuck processing movement', { movement_key: key, cameraKey: movement.cameraKey });
            await movementdb.put(key, { ...movement, processing_state: 'pending' as const });
            stuckCount++;
        }
    }
    if (stuckCount > 0) {
        logger.info('Recovered stuck processing movements', { count: stuckCount });
    }

    // Initialize processor with dependencies
    initProcessor({
        logger,
        cameradb,
        movementdb,
        settingsdb,
        diskstatusdb,
        getCameraCache,
        setCameraCache,
        getSettingsCache,
        setSettingsCache
    });

    // Initialize web server
    const httpServer: Server = await initWeb({
        logger,
        cameradb,
        movementdb,
        settingsdb,
        diskstatusdb,
        cameraCache: _inmem_cameraCache,
        getSettingsCache,
        setSettingsCache
    }, port);

    const actualPort = (httpServer.address() as any).port;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // Track intervals for cleanup
    const intervals: NodeJS.Timeout[] = [];

    // Start control loop (if interval > 0)
    if (controlLoopInterval > 0) {
        intervals.push(setInterval(async () => {
            try {
                await runControlLoop();
            } catch (e) {
                logger.error('Control loop error', { error: String(e) });
            }
        }, controlLoopInterval));
    }

    // Start disk cleanup loop (if interval > 0)
    if (diskCleanupInterval > 0) {
        intervals.push(setInterval(async () => {
            try {
                await runDiskCleanupLoop();
            } catch (e) {
                logger.error('Disk cleanup loop error', { error: String(e) });
            }
        }, diskCleanupInterval));
    }

    // Shutdown function
    let isShutdown = false;
    const shutdown = async (): Promise<void> => {
        if (isShutdown) return;
        isShutdown = true;
        
        if (isShuttingDown()) {
            logger.warn('Shutdown already in progress');
            return;
        }

        setShuttingDown(true);
        logger.info('Graceful shutdown initiated');

        // Clear intervals
        intervals.forEach(i => clearInterval(i));

        // Get shutdown timeout from settings
        const shutdownTimeout = _inmem_settingsCache.settings.shutdown_timeout_ms || 5000;
        const shutdownPromises: Promise<void>[] = [];

        // Stop all movement extraction ffmpeg processes
        for (const [movement_key, ffmpeg] of getMovementFFmpegProcesses().entries()) {
            if (ffmpeg?.exitCode === null) {
                logger.info('Stopping movement ffmpeg process', { movement: movement_key, pid: ffmpeg.pid });
                shutdownPromises.push(killProcess(ffmpeg, `movement-${movement_key}`, shutdownTimeout, logger));
            }
        }

        // Stop all camera streaming ffmpeg processes
        for (const cameraKey of Object.keys(_inmem_cameraCache)) {
            const cacheEntry = _inmem_cameraCache[cameraKey];
            if (!cacheEntry) continue;
            const { ffmpeg_task, cameraEntry } = cacheEntry;
            if (ffmpeg_task?.exitCode === null) {
                logger.info('Stopping camera ffmpeg process', { camera: cameraEntry.name, pid: ffmpeg_task.pid });
                shutdownPromises.push(killProcess(ffmpeg_task, cameraEntry.name, shutdownTimeout, logger));
            }
        }

        // Stop ML detection process
        const mlProcess = getMLDetectionProcess();
        if (mlProcess?.exitCode === null) {
            logger.info('Stopping ML detection process', { pid: mlProcess.pid });
            shutdownPromises.push(killProcess(mlProcess, 'ML-Detection', shutdownTimeout, logger));
        }

        // Wait for all processes to terminate
        await Promise.all(shutdownPromises);

        // Wait for any in-flight movement close handlers
        const closeHandlers = getMovementCloseHandlers();
        if (closeHandlers.size > 0) {
            logger.info('Waiting for movement close handlers', { count: closeHandlers.size });
            await Promise.all(closeHandlers.values()).catch(() => {});
        }

        logger.info('All processes terminated', { processCount: shutdownPromises.length });

        // Close SSE connections
        sseManager.closeAll();

        // Close HTTP server
        if (httpServer.listening) {
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }

        // Close database
        try {
            await db.close();
            logger.info('Database closed');
        } catch (e) {
            logger.error('Failed to close database', { error: String(e) });
        }

        setShuttingDown(false);
    };

    // Register signal handlers (for standalone server mode)
    if (registerSignalHandlers) {
        const signalShutdown = () => {
            shutdown().then(() => process.exit(0));
        };
        process.on('SIGTERM', signalShutdown);
        process.on('SIGINT', signalShutdown);
        process.on('SIGUSR2', signalShutdown);

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception', { error: error.message, stack: error.stack });
            shutdown().then(() => process.exit(1));
        });

        process.on('unhandledRejection', (reason) => {
            logger.error('Unhandled rejection', {
                reason: reason instanceof Error ? reason.message : String(reason)
            });
            shutdown().then(() => process.exit(1));
        });

        logger.info('Signal handlers registered');
    }

    logger.info('NVR Server initialized', { cameras: Object.keys(_inmem_cameraCache).length, port: actualPort });

    return {
        port: actualPort,
        baseUrl,
        db: { base: db, cameras: cameradb, movements: movementdb, settings: settingsdb },
        cameraCache: _inmem_cameraCache,
        getSettingsCache,
        runControlLoop,
        shutdown
    };
}

// ============================================================================
// Helper: Kill process with timeout
// ============================================================================

function killProcess(
    proc: { exitCode: number | null; pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean; once: (event: string, fn: (...args: any[]) => void) => void },
    name: string,
    timeoutMs: number,
    logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void }
): Promise<void> {
    return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
            logger.warn('Process did not terminate in time - forcing', { name, pid: proc.pid });
            try { proc.kill('SIGKILL'); } catch {}
            setTimeout(resolve, 100);
        }, timeoutMs);

        proc.once('close', () => {
            clearTimeout(timeout);
            logger.info('Process terminated', { name });
            resolve();
        });

        try {
            proc.kill();
        } catch (e) {
            logger.error('Failed to kill process', { name, error: String(e) });
            clearTimeout(timeout);
            resolve();
        }
    });
}

// ============================================================================
// Standalone Entry Point
// ============================================================================

// Only run main() if this file is executed directly (not imported)
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
    createServer().catch((e) => {
        defaultLogger.error('Failed to start application', { error: String(e) });
        process.exit(1);
    });
}
