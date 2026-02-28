/**
 * Web API routes and HTTP server configuration
 * Separated per required-server-program-structure.md
 */

import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import send from 'koa-send';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Level } from 'level';
import type { Server } from 'node:http';
import { runProcess } from './process-utils.js';
import { sseManager, formatMovementForSSE } from './sse-manager.js';
import { diskCheck, catalogVideo, DiskCheckReturn } from './diskcheck.js';
import type { Logger } from 'winston';

// Types
export interface Settings {
    disk_base_dir: string;
    disk_cleanup_interval: number;
    disk_cleanup_capacity: number;
    detection_enable: boolean;
    detection_model: string;
    detection_target_hw: string;
    detection_frames_path: string;
    detection_tag_filters: TagFilter[];
    /** ML process restart schedule in cron-like format: "HH:MM" (24-hour). Empty = disabled. Default: "01:00" */
    ml_restart_schedule?: string;
    /** Timeout for graceful process shutdown in ms (default: 5000) */
    shutdown_timeout_ms?: number;
    /** Timeout for stream verification in ms (default: 10000) */
    stream_verify_timeout_ms?: number;
}

export interface TagFilter {
    tag: string;
    minProbability: number;
}

export interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number | null;
    lhs_seg_duration_seq?: number;
    seconds: number;
    pollCount: number;
    consecutivePollsWithoutMovement: number;
    detection_status?: string;
    detection_output?: DetectionOutput;
    processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
    processing_started_at?: number;
    processing_completed_at?: number;
    processing_error?: string;
    processing_attempts?: number;
    endSegment?: number | null;
    playlist_path?: string;
    playlist_last_segment?: number;
    created?: number;
    start?: number;
    stop?: number;
    updated?: number;
    movement_key?: string;
    camera_key?: string;
    // Detection timing (camera movement detection)
    detection_started_at?: number;  // When movement was first detected
    detection_ended_at?: number;    // When movement ended (ENDLIST written)
    // Processing statistics (ML frame processing)
    frames_sent_to_ml?: number;     // Number of frames sent to ML detector
    frames_received_from_ml?: number; // Number of ML results received
    ml_total_processing_time_ms?: number; // Sum of all ML processing times
    ml_max_processing_time_ms?: number;   // Max single frame processing time
}

export interface MLTag {
    tag: string;
    maxProbability: number;
    count: number;
    maxProbabilityImage?: string;
}

export interface DetectionOutput {
    tags: MLTag[];
}

/** Disk cleanup status per camera, stored after each cleanup run */
export interface DiskStatusEntry {
    cameraKey: string;
    cameraName: string;
    lastRunAt: number;              // Timestamp when cleanup ran
    lastRunAt_en_GB: string;        // Human readable date
    filesDeleted: number;           // Number of files deleted for this camera
    bytesDeleted: number;           // Bytes deleted (from diskCheck folderStats)
    cutoffDate: number;             // Timestamp of newest deleted file
    cutoffDate_en_GB: string;       // Human readable cutoff date
    movementsDeleted: number;       // Number of movement records deleted
}

/** Aggregate disk status across all cameras */
export interface DiskStatus {
    lastRunAt: number;
    lastRunAt_en_GB: string;
    totalFilesDeleted: number;
    totalBytesDeleted: number;
    totalMovementsDeleted: number;
    perCamera: DiskStatusEntry[];
}

export interface CameraEntry {
    delete: boolean;
    name: string;
    folder: string;
    disk: string;
    ip?: string;
    passwd?: string;
    /** 
     * Optional direct URL for motion detection API.
     * If provided, used instead of constructing from ip/passwd.
     * Useful for testing or cameras with different API formats.
     */
    motionUrl?: string;
    /**
     * Stream source for ffmpeg input. Can be:
     * - RTSP URL: rtsp://user:pass@ip:554/path
     * - File path: /path/to/video.mp4 (loops with -stream_loop -1)
     * - Omitted: Constructs RTSP URL from ip/passwd fields
     */
    streamSource?: string;
    enable_streaming: boolean;
    enable_movement: boolean;
    pollsWithoutMovement: number;
    secMaxSingleMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    secMovementStartupDelay?: number;
    /** Processing pointer - last movement key that was processed for this camera (state, not config) */
    state_lastProcessedMovementKey?: string;
}

export interface CameraEntryClient extends Omit<CameraEntry, 'ip' | 'passwd'> {
    key: string;
}

export interface MovementToClient {
    key: string;
    movement: {
        cameraKey: string;
        startDate: number;
        startSegment: number | null;
        seconds: number;
        detection_status?: string;
        processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
        detection_output?: DetectionOutput;
    };
    startDate_en_GB: string;
}

export interface SettingsCache {
    settings: Settings;
    status: SettingsStatus;
}

export interface SettingsStatus {
    nextCheckInMinutes: number;
    lastChecked?: Date;
    fail: boolean;
    error?: string;
}

export interface CameraCacheEntry {
    cameraEntry: CameraEntry;
    ffmpeg_task?: any;
    movementDetectionStatus?: any;
    lastMovementCheck?: number;
    streamStartedAt?: number;
}

export interface CameraCache {
    [key: string]: CameraCacheEntry;
}

// Epoch offset for movement keys (Sept 13, 2020)
const MOVEMENT_KEY_EPOCH = 1600000000;

// Helper functions for movement key encoding
const encodeMovementKey = (n: number): string => n.toString().padStart(12, '0');

/**
 * Get the frames output path based on settings
 */
function getFramesPath(settings: Settings, disk: string, folder: string): string {
    const baseDir = settings.disk_base_dir || disk;
    return settings.detection_frames_path
        ? `${baseDir}/${settings.detection_frames_path}`.replace(/\/+/g, '/')
        : `${disk}/${folder}`;
}

/**
 * Ensure directory exists, create if needed
 */
async function ensureDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder);
        if (!stat.isDirectory()) {
            throw new Error(`${folder} is not a directory`);
        }
        return true;
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            try {
                await fs.mkdir(folder);
                return true;
            } catch (mkdirError) {
                throw new Error(`Cannot create ${folder}: ${mkdirError}`);
            }
        } else {
            throw new Error(`Cannot stat ${folder}: ${e}`);
        }
    }
}

/**
 * Clear down disk space by removing old recordings
 */
async function clearDownDisk(
    diskDir: string,
    cameraKeys: string[],
    cleanupCapacity: number,
    cameraCache: CameraCache,
    settingsCache: SettingsCache,
    movementdb: any,
    logger: SimpleLogger
): Promise<DiskCheckReturn> {
    const cameraFolders = cameraKeys.map(key => `${diskDir}/${cameraCache[key].cameraEntry.folder}`);
    const mlFramesFolder = settingsCache.settings.detection_frames_path
        ? `${diskDir}/${settingsCache.settings.detection_frames_path}`.replace(/\/+/g, '/')
        : null;

    const foldersToClean = mlFramesFolder && !cameraFolders.includes(mlFramesFolder)
        ? [...cameraFolders, mlFramesFolder]
        : cameraFolders;

    const diskres = await diskCheck(diskDir, foldersToClean, cleanupCapacity);
    logger.info('Disk check complete', diskres);
    
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce(
            (acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs
                ? (diskres.folderStats[cur].lastRemovedctimeMs > acc ? diskres.folderStats[cur].lastRemovedctimeMs : acc)
                : acc,
            0
        );
        
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            // Movement keys are stored as millisecond timestamps (e.g., "1766090503015")
            // Delete all movements with startDate <= mostRecentctimMs
            const keytoDeleteTo = cleanupCapacity === -1 ? null : mostRecentctimMs.toString();
            const deleteKeys: string[] = [];
            
            for await (const [encodedKey, value] of movementdb.iterator(keytoDeleteTo ? { lte: keytoDeleteTo } : {})) {
                if (cameraKeys.includes(value.cameraKey)) {
                    deleteKeys.push(encodedKey);
                }
            }

            if (deleteKeys.length > 0) {
                logger.info('Deleting old movements from database', { 
                    count: deleteKeys.length,
                    oldestDeletedKey: deleteKeys[0],
                    newestDeletedKey: deleteKeys[deleteKeys.length - 1]
                });
                await movementdb.batch(deleteKeys.map((k: string) => ({ type: 'del', key: k })) as any);
            }
        }
    }
    return diskres;
}

/** Simple logger interface for dependency injection (subset of winston Logger) */
export interface SimpleLogger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

export interface WebServerDependencies {
    logger: SimpleLogger;
    cameradb: any;
    movementdb: any;
    settingsdb: any;
    diskstatusdb: any;
    cameraCache: CameraCache;
    getSettingsCache: () => SettingsCache;
    setSettingsCache: (cache: SettingsCache) => void;
}

/**
 * Initialize and start the web server
 */
export async function initWeb(deps: WebServerDependencies, port: number = 8080): Promise<Server> {
    const { logger, cameradb, movementdb, settingsdb, diskstatusdb, cameraCache, getSettingsCache, setSettingsCache } = deps;

    const assets = new Router()
        .get('/image/:moment', async (ctx) => {
            const moment = ctx.params['moment'];

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)));
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const c: CameraEntry = await cameradb.get(m.cameraKey);
                if (!c) {
                    ctx.throw(404, `Camera not found: ${m.cameraKey}`);
                    return;
                }
                const hasDetections = m.detection_output?.tags && m.detection_output.tags.length > 0;
                const serve = `${c.disk}/${c.folder}/${hasDetections ? 'mlimage' : 'image'}${moment}.jpg`;
                await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/frame/:moment/:filename', async (ctx) => {
            const moment = ctx.params['moment'];
            const filename = ctx.params['filename'];

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)));
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const { disk, folder } = cameraCache[m.cameraKey].cameraEntry;
                const framesPath = getFramesPath(getSettingsCache().settings, disk, folder);
                const serve = `${framesPath}/${filename}`;
                await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/video/live/:cameraKey/:file', async (ctx) => {
            const cameraKey = ctx.params['cameraKey'];
            const file = ctx.params['file'];

            try {
                const c = await cameradb.get(cameraKey);
                if (!c) {
                    ctx.throw(404, `Camera not found: ${cameraKey}`);
                    return;
                }
                const serve = `${c.disk}/${c.folder}/${file}`;
                await fs.stat(serve);

                if (file.endsWith('.m3u8')) {
                    ctx.set('content-type', 'application/x-mpegURL');
                } else if (file.endsWith('.ts')) {
                    ctx.set('content-type', 'video/MP2T');
                } else {
                    ctx.throw(400, `unknown file=${file}`);
                }

                ctx.body = createReadStream(serve);
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/video/:startSegment/:seconds/:cameraKey/:file', async (ctx) => {
            const startSegment = ctx.params['startSegment'];
            const seconds = ctx.params['seconds'];
            const cameraKey = ctx.params['cameraKey'];
            const file = ctx.params['file'];

            const cameraEntry: CameraEntry = cameraCache[cameraKey].cameraEntry;

            if (file.endsWith('.m3u8')) {
                const segmentInt = parseInt(startSegment);
                const secondsInt = parseInt(seconds);
                if (isNaN(segmentInt) || isNaN(secondsInt)) {
                    ctx.throw(400, `message=${startSegment} or ${seconds} not valid values`);
                } else {
                    const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0;
                    const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0;
                    const segDuration = 2;
                    const numSegments = Math.max(1, Math.round(secondsInt / segDuration) + preseq + postseq);

                    logger.debug('Generating playlist', {
                        cameraKey,
                        startSegment: segmentInt,
                        seconds: secondsInt,
                        preseq,
                        postseq,
                        numSegments,
                        firstSegment: segmentInt - preseq,
                        lastSegment: segmentInt + numSegments - preseq - 1
                    });

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${segDuration}
` + [...Array(numSegments).keys()].map(n => `#EXTINF:${segDuration}.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n";

                    ctx.set('content-type', 'application/x-mpegURL');
                    ctx.body = body;
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/${file}`;
                try {
                    await fs.stat(serve);
                    ctx.set('content-type', 'video/MP2T');
                    ctx.body = createReadStream(serve);
                } catch (e) {
                    const err: Error = e as Error;
                    logger.warn('Video segment not found', {
                        file,
                        path: serve,
                        cameraKey,
                        error: err.message
                    });
                    ctx.throw(404, `Segment not found: ${file}`);
                }
            } else {
                ctx.throw(400, `unknown file=${file}`);
            }
        })
        .get('/mp4/:startSegment/:seconds/:cameraKey', async (ctx) => {
            const startSegment = ctx.params['startSegment'];
            const seconds = ctx.params['seconds'];
            const cameraKey = ctx.params['cameraKey'];

            try {
                const cameraEntry: CameraEntry = cameraCache[cameraKey].cameraEntry;
                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0;
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0;
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/save${startSegment}-${seconds}.mp4`;

                const result = await runProcess({
                    name: `mp4-gen-${cameraKey}-${startSegment}`,
                    cmd: '/usr/bin/ffmpeg',
                    args: ['-y', '-i', `http://localhost:${port}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${preseq > 0 || postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve],
                    timeout: 50000
                });

                if (result.code !== 0) {
                    throw new Error(`ffmpeg failed with code ${result.code}: ${result.stderr}`);
                }

                ctx.set('Content-Type', 'video/mp4');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                ctx.throw(500, `error mp4 gen error=${e}`);
            }
        })
        .get('{/*path}', async (ctx) => {
            const path = ctx.params['path'];
            logger.debug('Serving static file', { path });
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' });
        });

    const api = new Router({ prefix: '/api' })
        .post('/settings', async (ctx) => {
            logger.info('Settings save', { settings: ctx.request.body });
            if (ctx.request.body) {
                const new_settings: Settings = ctx.request.body as Settings;
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir);
                    if (!dirchk.isDirectory()) throw new Error(`${new_settings.disk_base_dir} is not a directory`);
                    await settingsdb.put('config', new_settings);
                    const currentCache = getSettingsCache();
                    setSettingsCache({
                        ...currentCache,
                        settings: new_settings,
                        status: { ...currentCache.status, nextCheckInMinutes: new_settings.disk_cleanup_interval }
                    });
                    ctx.status = 201;
                } catch (err) {
                    ctx.body = err;
                    ctx.status = 500;
                }
            } else {
                ctx.body = 'no body';
                ctx.status = 500;
            }
        })
        .get('/diskstatus', async (ctx) => {
            // Return disk cleanup status for all cameras
            try {
                const perCamera: DiskStatusEntry[] = [];
                let totalFilesDeleted = 0;
                let totalBytesDeleted = 0;
                let totalMovementsDeleted = 0;
                let lastRunAt = 0;

                for await (const [, entry] of diskstatusdb.iterator()) {
                    perCamera.push(entry);
                    totalFilesDeleted += entry.filesDeleted || 0;
                    totalBytesDeleted += entry.bytesDeleted || 0;
                    totalMovementsDeleted += entry.movementsDeleted || 0;
                    if (entry.lastRunAt > lastRunAt) {
                        lastRunAt = entry.lastRunAt;
                    }
                }

                const lastRunAt_en_GB = lastRunAt > 0 
                    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: true }).format(new Date(lastRunAt))
                    : 'Never';

                const diskStatus: DiskStatus = {
                    lastRunAt,
                    lastRunAt_en_GB,
                    totalFilesDeleted,
                    totalBytesDeleted,
                    totalMovementsDeleted,
                    perCamera
                };

                ctx.body = diskStatus;
            } catch (e) {
                logger.error('Error fetching disk status', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .get('/stats', async (ctx) => {
            // On-demand DB stats — scans movementdb to compute per-camera and per-day counts
            try {
                const perCamera: { [cameraKey: string]: { total: number, oldest: number, newest: number, perDay: { [day: string]: number } } } = {};

                for await (const [key, value] of movementdb.iterator()) {
                    const cam = value.cameraKey || 'unknown';
                    if (!perCamera[cam]) {
                        perCamera[cam] = { total: 0, oldest: Number(key), newest: Number(key), perDay: {} };
                    }
                    const entry = perCamera[cam];
                    entry.total++;
                    const ts = Number(key);
                    if (ts < entry.oldest) entry.oldest = ts;
                    if (ts > entry.newest) entry.newest = ts;
                    const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(new Date(ts));
                    entry.perDay[day] = (entry.perDay[day] || 0) + 1;
                }

                // Add camera names from cache
                const cameras: { cameraKey: string, cameraName: string, total: number, oldest: string, newest: string, perDay: { date: string, count: number }[] }[] = [];
                for (const [cameraKey, stats] of Object.entries(perCamera)) {
                    const cameraName = cameraCache[cameraKey]?.cameraEntry?.name || cameraKey;
                    const fmt = (ts: number) => ts > 0 
                        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: true }).format(new Date(ts))
                        : 'N/A';
                    cameras.push({
                        cameraKey,
                        cameraName,
                        total: stats.total,
                        oldest: fmt(stats.oldest),
                        newest: fmt(stats.newest),
                        perDay: Object.entries(stats.perDay)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([date, count]) => ({ date, count }))
                    });
                }

                const totalMovements = cameras.reduce((sum, c) => sum + c.total, 0);
                const totalCameras = Object.keys(cameraCache).filter(k => !cameraCache[k].cameraEntry.delete).length;

                ctx.body = { totalCameras, totalMovements, cameras };
            } catch (e) {
                logger.error('Error computing stats', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .post('/diskcleanup', async (ctx) => {
            // Force run disk cleanup with optional target capacity
            const targetCapacity = ctx.request.query['target'] 
                ? parseInt(ctx.request.query['target'] as string, 10) 
                : null;
            
            const settingsCache = getSettingsCache();
            const { settings } = settingsCache;
            
            if (!settings.disk_base_dir) {
                ctx.body = { error: 'Disk base directory not configured' };
                ctx.status = 400;
                return;
            }

            // Use target from query param, or current setting, default to 90%
            const cleanupCapacity = targetCapacity ?? settings.disk_cleanup_capacity ?? 90;
            
            logger.info('Manual disk cleanup triggered', { targetCapacity: cleanupCapacity });

            try {
                const cameraKeys = Object.keys(cameraCache).filter(
                    c => (!cameraCache[c].cameraEntry.delete) && cameraCache[c].cameraEntry.enable_streaming
                );

                const diskres = await clearDownDisk(
                    settings.disk_base_dir,
                    cameraKeys,
                    cleanupCapacity,
                    cameraCache,
                    settingsCache,
                    movementdb,
                    logger
                );

                // Save disk status per camera
                const now = Date.now();
                const nowFormatted = new Intl.DateTimeFormat('en-GB', { 
                    dateStyle: 'short', timeStyle: 'short', hour12: true 
                }).format(new Date(now));

                for (const cameraKey of cameraKeys) {
                    const folder = `${settings.disk_base_dir}/${cameraCache[cameraKey].cameraEntry.folder}`;
                    const folderStats = diskres.folderStats[folder];
                    const cutoffDate = folderStats?.lastRemovedctimeMs || 0;
                    const cutoffFormatted = cutoffDate > 0 
                        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: true }).format(new Date(cutoffDate))
                        : 'N/A';

                    await diskstatusdb.put(cameraKey, {
                        cameraKey,
                        cameraName: cameraCache[cameraKey].cameraEntry.name,
                        lastRunAt: now,
                        lastRunAt_en_GB: nowFormatted,
                        filesDeleted: folderStats?.removedFiles || 0,
                        bytesDeleted: folderStats?.removedMB || 0,
                        cutoffDate,
                        cutoffDate_en_GB: cutoffFormatted,
                        movementsDeleted: 0,
                    });
                }

                logger.info('Manual disk cleanup complete', { removedMB: diskres.revmovedMBTotal });

                ctx.body = { 
                    success: true, 
                    targetCapacity: cleanupCapacity,
                    removedMB: diskres.revmovedMBTotal,
                    folderStats: diskres.folderStats
                };
            } catch (e: any) {
                logger.error('Manual disk cleanup failed', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .post('/camera/:id', async (ctx) => {
            const cameraKey = ctx.params['id'];
            const deleteOption = ctx.request.query['delopt'];

            logger.info('Camera save', { cameraKey, deleteOption, camera: ctx.request.body });
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body as CameraEntry;
                const folder = `${new_ce.disk}/${new_ce.folder}`;
                
                if (cameraKey === 'new') {
                    try {
                        await ensureDir(folder);
                        const new_key = "C" + ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH);
                        // Initialize processing pointer for new camera
                        const newCamera: CameraEntry = { 
                            delete: false, 
                            ...new_ce,
                            state_lastProcessedMovementKey: '0'  // Start from beginning
                        };
                        await cameradb.put(new_key, newCamera);
                        cameraCache[new_key] = { cameraEntry: new_ce };
                        ctx.status = 201;
                    } catch (e) {
                        ctx.throw(400, e as Error);
                    }
                } else {
                    try {
                        const old_cc: CameraCacheEntry = cameraCache[cameraKey];
                        if (!old_cc) throw new Error(`camera ${cameraKey} not found`);

                        if (!deleteOption) {
                            await ensureDir(folder);
                        }

                        logger.info('Stopping existing camera processes', {
                            camera: old_cc.cameraEntry.name,
                            cameraKey,
                            hasFFmpegTask: !!old_cc.ffmpeg_task
                        });

                        cameraCache[cameraKey] = {
                            ...cameraCache[cameraKey],
                            cameraEntry: { ...old_cc.cameraEntry, enable_streaming: false },
                        };

                        if (old_cc.ffmpeg_task && old_cc.ffmpeg_task.exitCode === null) {
                            logger.info('Terminating ffmpeg streaming process', {
                                camera: old_cc.cameraEntry.name,
                                pid: old_cc.ffmpeg_task.pid
                            });

                            await new Promise<void>((resolve) => {
                                const timeout = setTimeout(() => {
                                    logger.warn('ffmpeg termination timeout - forcing', {
                                        camera: old_cc.cameraEntry.name,
                                        cameraKey
                                    });
                                    resolve();
                                }, 5000);

                                old_cc.ffmpeg_task.once('close', () => {
                                    clearTimeout(timeout);
                                    logger.info('ffmpeg streaming process terminated', {
                                        camera: old_cc.cameraEntry.name,
                                        cameraKey
                                    });
                                    resolve();
                                });

                                old_cc.ffmpeg_task.kill();
                            });
                        }

                        if (!deleteOption) {
                            // Preserve state_ fields - don't let client overwrite them
                            const { state_lastProcessedMovementKey: _drop, ...clientData } = new_ce as CameraEntry & { state_lastProcessedMovementKey?: string };
                            const new_vals: CameraEntry = { 
                                ...old_cc.cameraEntry, 
                                ...clientData,
                                // Preserve existing state fields
                                state_lastProcessedMovementKey: old_cc.cameraEntry.state_lastProcessedMovementKey
                            };
                            await cameradb.put(cameraKey, new_vals);
                            cameraCache[cameraKey] = { cameraEntry: new_vals };

                            logger.info('Camera configuration updated', {
                                camera: new_vals.name,
                                cameraKey,
                                streaming: new_vals.enable_streaming,
                                movement: new_vals.enable_movement
                            });

                            ctx.status = 201;
                        } else {
                            logger.info('Camera operation', {
                                camera: old_cc.cameraEntry.name,
                                cameraKey,
                                deleteOption
                            });

                            if (deleteOption === 'reset') {
                                logger.info('Resetting camera recordings', { cameraKey });
                                const currentSettings = getSettingsCache();
                                const diskres = await clearDownDisk(
                                    currentSettings.settings.disk_base_dir,
                                    [cameraKey],
                                    -1,
                                    cameraCache,
                                    currentSettings,
                                    movementdb,
                                    logger
                                );
                                logger.info('Camera movement files deleted', { cameraKey, diskres });

                                const movementsToDelete: string[] = [];
                                for await (const [key, movement] of movementdb.iterator()) {
                                    if (movement.cameraKey === cameraKey) {
                                        movementsToDelete.push(key);
                                    }
                                }

                                if (movementsToDelete.length > 0) {
                                    await movementdb.batch(movementsToDelete.map((k: string) => ({ type: 'del', key: k })) as any);
                                }

                                logger.info('Camera movements deleted from database', {
                                    cameraKey,
                                    count: movementsToDelete.length
                                });
                                ctx.status = 200;
                            } else if (deleteOption === 'delall') {
                                const currentSettings = getSettingsCache();
                                const diskres = await clearDownDisk(
                                    currentSettings.settings.disk_base_dir,
                                    [cameraKey],
                                    -1,
                                    cameraCache,
                                    currentSettings,
                                    movementdb,
                                    logger
                                );
                                logger.info('Camera files deleted', { cameraKey, diskres });
                            }

                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                const new_vals: CameraEntry = { ...old_cc.cameraEntry, delete: true };
                                await cameradb.put(cameraKey, new_vals);
                                cameraCache[cameraKey] = { cameraEntry: new_vals };

                                logger.info('Camera marked as deleted', {
                                    camera: new_vals.name,
                                    cameraKey
                                });

                                ctx.status = 200;
                            } else if (deleteOption !== 'reset') {
                                logger.warn('Unknown delete option', { deleteOption });
                                ctx.status = 400;
                            }
                        }
                    } catch (e) {
                        logger.error('Camera update error', { error: String(e) });
                        ctx.throw(400, e as Error);
                    }
                }
            } else {
                ctx.status = 500;
            }
        })
        .get('/movements/stream', (ctx) => {
            sseManager.addClient(ctx);
        })
        .get('/movements', async (ctx) => {
            const mode = ctx.query['mode'];
            const limitParam = ctx.query['limit'];
            const cursorParam = ctx.query['cursor']; // Last key from previous page for pagination
            const limit = limitParam ? Math.min(parseInt(limitParam as string, 10) || 1000, 10000) : 1000;
            
            const cameras: CameraEntryClient[] = Object.entries(cameraCache)
                .filter(([_, value]) => !value.cameraEntry.delete)
                .map(([key, value]) => {
                    const { cameraEntry } = value;
                    const { ip, passwd, ...clientCameraEntry } = cameraEntry;
                    return { key, ...clientCameraEntry } as CameraEntryClient;
                });

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res) => {
                let movements: MovementToClient[] = [];
                let nextCursor: string | null = null;
                let hasMore = false;

                if (mode === "Time") {
                    for (const c of cameras) {
                        const listfiles = await catalogVideo(`${c.disk}/${c.folder}`);
                        // Time mode implementation - currently empty per original
                    }
                    res({ config: getSettingsCache(), cameras, movements, hasMore: false, nextCursor: null });
                } else {
                    // Build iterator options: reverse order, with optional cursor for pagination
                    const iteratorOpts: { reverse: boolean; limit: number; lt?: string } = { 
                        reverse: true, 
                        limit: limit * 10  // Fetch extra to handle filtering
                    };
                    
                    // If cursor provided, start from just before that key
                    if (cursorParam && typeof cursorParam === 'string') {
                        iteratorOpts.lt = cursorParam;
                    }

                    for await (const [key, value] of movementdb.iterator(iteratorOpts)) {
                        const { detection_output } = value;

                        let tags = detection_output?.tags || null;
                        if (mode === 'Filtered') {
                            const { detection_tag_filters } = getSettingsCache().settings || {};
                            if (!detection_tag_filters || detection_tag_filters.length === 0) {
                                tags = [];
                            } else if (tags && Array.isArray(tags) && tags.length > 0) {
                                tags = tags.filter((t: MLTag) => {
                                    const filter = detection_tag_filters.find(f => f.tag === t.tag);
                                    return filter ? t.maxProbability >= filter.minProbability : false;
                                });
                            } else {
                                tags = [];
                            }
                        }
                        
                        if (mode === 'Movement' || (mode === 'Filtered' && tags && tags.length > 0)) {
                            if (!value.startDate || isNaN(value.startDate)) continue;
                            const startDate = new Date(value.startDate);
                            if (isNaN(startDate.getTime())) continue;

                            // Check if we've reached the limit - if so, mark hasMore and set cursor
                            if (movements.length >= limit) {
                                hasMore = true;
                                nextCursor = key;
                                break;
                            }

                            movements.push({
                                key,
                                startDate_en_GB: new Intl.DateTimeFormat('en-GB', {
                                    ...(startDate.toDateString() !== (new Date()).toDateString() && { weekday: "short" }),
                                    minute: "2-digit",
                                    hour: "2-digit",
                                    hour12: true
                                }).format(startDate),
                                movement: {
                                    cameraKey: value.cameraKey,
                                    startDate: value.startDate,
                                    startSegment: value.startSegment,
                                    seconds: value.seconds,
                                    detection_status: value.detection_status || 'complete',
                                    processing_state: value.processing_state,
                                    // Detection fields
                                    ...(value.pollCount !== undefined && { pollCount: value.pollCount }),
                                    ...(value.consecutivePollsWithoutMovement !== undefined && { consecutivePollsWithoutMovement: value.consecutivePollsWithoutMovement }),
                                    ...(value.playlist_path && { playlist_path: value.playlist_path }),
                                    ...(value.playlist_last_segment !== undefined && { playlist_last_segment: value.playlist_last_segment }),
                                    ...(value.processing_error && { processing_error: value.processing_error }),
                                    ...(tags && tags.length > 0 && { detection_output: { tags } }),
                                    // Timing fields
                                    ...(value.detection_started_at && { detection_started_at: value.detection_started_at }),
                                    ...(value.detection_ended_at && { detection_ended_at: value.detection_ended_at }),
                                    ...(value.processing_started_at && { processing_started_at: value.processing_started_at }),
                                    ...(value.processing_completed_at && { processing_completed_at: value.processing_completed_at }),
                                    // ML stats
                                    ...(value.frames_sent_to_ml !== undefined && { frames_sent_to_ml: value.frames_sent_to_ml }),
                                    ...(value.frames_received_from_ml !== undefined && { frames_received_from_ml: value.frames_received_from_ml }),
                                    ...(value.ml_total_processing_time_ms !== undefined && { ml_total_processing_time_ms: value.ml_total_processing_time_ms }),
                                    ...(value.ml_max_processing_time_ms !== undefined && { ml_max_processing_time_ms: value.ml_max_processing_time_ms })
                                }
                            });
                        }
                    }
                    res({ config: getSettingsCache(), cameras, movements, hasMore, nextCursor });
                }
            });
        });

    const nav = new Router()
        .get('/network', async (ctx) => {
            ctx.redirect(`http://${ctx.headers.host ? ctx.headers.host.split(":")[0] : 'localhost'}:3998`);
        })
        .get('/metrics', async (ctx) => {
            ctx.redirect(`http://${ctx.headers.host ? ctx.headers.host.split(":")[0] : 'localhost'}:3000/d/T3OrKihMk/our-house?orgId=1`);
        });

    const app = new Koa();

    // Global error handler
    app.on('error', (err, ctx) => {
        if (err.code === 'ECONNRESET' ||
            err.code === 'EPIPE' ||
            err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            err.message?.includes('Premature close')) {
            logger.debug('Client disconnected', {
                path: ctx.path,
                error: err.code || err.message
            });
            return;
        }

        logger.error('Application error', {
            error: err.message,
            stack: err.stack,
            path: ctx.path,
            method: ctx.method
        });
    });

    app.use(bodyParser());
    app.use(api.routes());
    app.use(nav.routes());
    app.use(assets.routes());

    logger.info('NVR Server starting', { port });
    const server = app.listen(port);

    return server;
}

export { clearDownDisk, ensureDir, getFramesPath, encodeMovementKey, MOVEMENT_KEY_EPOCH };
