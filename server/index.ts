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
 */

import { Level } from 'level';

import { logger } from './logger.js';
import { initWeb } from './www.js';
import {
    initProcessor,
    runControlLoop,
    runDiskCleanupLoop,
    setShuttingDown,
    isShuttingDown,
    getMLDetectionProcess,
    getMovementFFmpegProcesses,
    getMovementCloseHandlers
} from './processor.js';
import { sseManager } from './sse-manager.js';
import { setLogger } from './process-utils.js';
import { setLogger as setSSELogger } from './sse-manager.js';

import type { CameraEntry, CameraCache, CameraCacheEntry, Settings, SettingsCache } from './www.js';

// ============================================================================
// Initialize utilities with logger
// ============================================================================

setLogger(logger);
setSSELogger(logger);

// ============================================================================
// Database Setup
// ============================================================================

const db = new Level(process.env['DBPATH'] || './mydb', { valueEncoding: 'json' });
const cameradb = db.sublevel<string, CameraEntry>('cameras', { valueEncoding: 'json' });
const movementdb = db.sublevel('movements', { valueEncoding: 'json' });
const settingsdb = db.sublevel<string, Settings>('settings', { valueEncoding: 'json' });

// ============================================================================
// In-Memory State (clearly named per requirements)
// ============================================================================

let _inmem_cameraCache: CameraCache = {};
let _inmem_settingsCache: SettingsCache;

// ============================================================================
// State Accessors (for dependency injection)
// ============================================================================

function getCameraCache(): CameraCache {
    return _inmem_cameraCache;
}

function setCameraCache(key: string, entry: CameraCacheEntry): void {
    _inmem_cameraCache[key] = entry;
}

function getSettingsCache(): SettingsCache {
    return _inmem_settingsCache;
}

function setSettingsCache(cache: SettingsCache): void {
    _inmem_settingsCache = cache;
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown()) {
        logger.warn('Shutdown already in progress');
        return;
    }

    setShuttingDown(true);
    logger.info('Graceful shutdown initiated', { signal });

    const shutdownPromises: Promise<void>[] = [];

    // Stop all movement extraction ffmpeg processes
    const movementProcesses = getMovementFFmpegProcesses();
    for (const [movement_key, ffmpeg] of movementProcesses.entries()) {
        if (ffmpeg && ffmpeg.exitCode === null) {
            logger.info('Stopping movement ffmpeg process', { movement: movement_key, pid: ffmpeg.pid });

            const promise = new Promise<void>((resolve) => {
                let forceKillTimeout: NodeJS.Timeout | null = null;

                const timeout = setTimeout(() => {
                    logger.warn('Movement ffmpeg did not terminate in time - forcing', {
                        movement: movement_key,
                        pid: ffmpeg.pid
                    });
                    try {
                        ffmpeg.kill('SIGKILL');
                    } catch (e) {
                        logger.error('Failed to force kill movement ffmpeg', { error: String(e) });
                    }
                    forceKillTimeout = setTimeout(() => resolve(), 1000);
                }, 5000);

                ffmpeg.once('close', () => {
                    clearTimeout(timeout);
                    if (forceKillTimeout) clearTimeout(forceKillTimeout);
                    logger.info('Movement ffmpeg terminated', { movement: movement_key });
                    resolve();
                });

                try {
                    ffmpeg.kill();
                } catch (e) {
                    logger.error('Failed to kill movement ffmpeg', { error: String(e) });
                    clearTimeout(timeout);
                    resolve();
                }
            });

            shutdownPromises.push(promise);
        }
    }

    // Stop all camera streaming ffmpeg processes
    for (const cameraKey of Object.keys(_inmem_cameraCache)) {
        const cacheEntry = _inmem_cameraCache[cameraKey];
        if (!cacheEntry) continue;

        const { ffmpeg_task, cameraEntry } = cacheEntry;
        if (ffmpeg_task && ffmpeg_task.exitCode === null) {
            logger.info('Stopping camera ffmpeg process', { camera: cameraEntry.name, pid: ffmpeg_task.pid });

            const promise = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn('ffmpeg process did not terminate in time - forcing', {
                        camera: cameraEntry.name,
                        pid: ffmpeg_task.pid
                    });
                    try {
                        ffmpeg_task.kill('SIGKILL');
                    } catch (e) {
                        logger.error('Failed to force kill ffmpeg', { error: String(e) });
                    }
                    resolve();
                }, 5000);

                ffmpeg_task.once('close', () => {
                    clearTimeout(timeout);
                    logger.info('Camera ffmpeg terminated', { camera: cameraEntry.name });
                    resolve();
                });

                try {
                    ffmpeg_task.kill();
                } catch (e) {
                    logger.error('Failed to kill ffmpeg process', { error: String(e) });
                    clearTimeout(timeout);
                    resolve();
                }
            });

            shutdownPromises.push(promise);
        }
    }

    // Stop ML detection process
    const mlProcess = getMLDetectionProcess();
    if (mlProcess && mlProcess.exitCode === null) {
        logger.info('Stopping ML detection process', { pid: mlProcess.pid });

        const promise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn('ML detection process did not terminate in time - forcing', {
                    pid: mlProcess.pid
                });
                try {
                    mlProcess.kill('SIGKILL');
                } catch (e) {
                    logger.error('Failed to force kill ML process', { error: String(e) });
                }
                resolve();
            }, 5000);

            mlProcess.once('close', () => {
                clearTimeout(timeout);
                logger.info('ML detection process terminated');
                resolve();
            });

            try {
                mlProcess.kill();
            } catch (e) {
                logger.error('Failed to kill ML detection process', { error: String(e) });
                clearTimeout(timeout);
                resolve();
            }
        });

        shutdownPromises.push(promise);
    }

    // Wait for all processes to terminate
    await Promise.all(shutdownPromises);

    // Wait for any in-flight movement close handlers to complete DB writes
    const closeHandlers = getMovementCloseHandlers();
    if (closeHandlers.size > 0) {
        logger.info('Waiting for movement close handlers', { count: closeHandlers.size });
        await Promise.all(closeHandlers.values()).catch(() => {});
    }

    logger.info('All processes terminated - exiting', {
        signal,
        processCount: shutdownPromises.length
    });

    // Close SSE connections
    sseManager.closeAll();

    // Close database
    try {
        await db.close();
        logger.info('Database closed');
    } catch (e) {
        logger.error('Failed to close database', { error: String(e) });
    }

    process.exit(0);
}

// ============================================================================
// Main Application Entry
// ============================================================================

async function main(): Promise<void> {
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
    } catch (e) {
        // No saved settings - use defaults
        logger.info('No saved settings found, using defaults');
    }

    // Initialize processor with dependencies
    initProcessor({
        logger,
        cameradb,
        movementdb,
        settingsdb,
        getCameraCache,
        setCameraCache,
        getSettingsCache,
        setSettingsCache
    });

    // Start the main control loop (runs every 1 second per requirements)
    setInterval(async () => {
        try {
            await runControlLoop();
        } catch (e) {
            logger.error('Control loop error', { error: String(e) });
        }
    }, 1000);

    // Start the disk cleanup loop (runs every 1 minute per requirements)
    setInterval(async () => {
        try {
            await runDiskCleanupLoop();
        } catch (e) {
            logger.error('Disk cleanup loop error', { error: String(e) });
        }
    }, 60000);

    // Initialize web server
    const PORT = parseInt(process.env['PORT'] || '8080');
    await initWeb({
        logger,
        cameradb,
        movementdb,
        settingsdb,
        cameraCache: _inmem_cameraCache,
        settingsCache: _inmem_settingsCache,
        setSettingsCache
    }, PORT);

    // Register graceful shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception - initiating shutdown', {
            error: error.message,
            stack: error.stack
        });
        gracefulShutdown('uncaughtException').then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled rejection - initiating shutdown', {
            reason: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined
        });
        gracefulShutdown('unhandledRejection').then(() => process.exit(1));
    });

    logger.info('Shutdown handlers registered', {
        signals: ['SIGTERM', 'SIGINT', 'SIGUSR2', 'uncaughtException', 'unhandledRejection']
    });

    logger.info('NVR Server initialized', {
        cameras: Object.keys(_inmem_cameraCache).length,
        port: PORT
    });
}

// Start the application
main().catch((e) => {
    logger.error('Failed to start application', { error: String(e) });
    process.exit(1);
});
