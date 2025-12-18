/**
 * Processor - Control loop logic for camera streaming and movement detection
 * Separated per required-server-program-structure.md
 * 
 * Implements the main control loop with the following functions:
 * - controllerDetector() - Manages ML detection process lifecycle
 * - controllerFFmpeg() - Starts/stops ffmpeg streaming per camera
 * - controllerFFmpegConfirmation() - Ensures ffmpeg is producing expected output
 * - detectCameraMovement() - Detects movement from camera API
 * - triggerProcessMovement() - Processes movements with ML detection
 * - sseKeepAlive() - Sends keep-alive to SSE clients
 * - clearDownDisk() - Removes old recordings when disk is full
 */

import fs from 'fs/promises';
import { ChildProcessWithoutNullStreams } from 'child_process';
import {
    spawnProcess,
    createFFmpegFrameProcessor,
    createMLResultProcessor,
    verifyStreamStartup,
    setDependencies,
    setLogger
} from './process-utils.js';
import { sseManager, formatMovementForSSE } from './sse-manager.js';
import { diskCheck, DiskCheckReturn } from './diskcheck.js';
import type { Logger } from 'winston';
import type {
    Settings,
    CameraEntry,
    CameraCache,
    CameraCacheEntry,
    SettingsCache,
    MovementEntry,
    MLTag
} from './www.js';
import { encodeMovementKey, MOVEMENT_KEY_EPOCH, ensureDir, getFramesPath } from './www.js';

// ============================================================================
// In-Memory State (prefixed with _inmem for clarity per requirements)
// ============================================================================

// Track if shutdown is in progress
let _inmem_isShuttingDown = false;

// Global ML detection process
let _inmem_mlDetectionProcess: ChildProcessWithoutNullStreams | null = null;

// Track in-flight movement close handlers (for graceful shutdown)
const _inmem_movementCloseHandlers: Map<string, Promise<void>> = new Map();

// Track when frames are sent to ML for timing
const _inmem_mlFrameSentTimes: Map<string, number> = new Map();

// Track pending updates per movement to avoid concurrent DB writes
const _inmem_pendingUpdates: Set<number> = new Set();

// FFmpeg controller in-progress tracking (per camera)
const _inmem_controllerFFmpeg_inprogress: { [key: string]: { inprogress: boolean; checkFrom: number } } = {};

// FFmpeg confirmation tracking (per camera)
const _inmem_controllerFFmpegConfirmation: { [key: string]: { lastCheck: number; confirmed: boolean } } = {};

// SSE keep-alive tracking
let _inmem_lastSSEKeepAlive = 0;

// Disk cleanup tracking
let _inmem_lastDiskCheck = 0;

// Current ffmpeg processing state (only one movement processed at a time)
let _inmem_currentProcessingMovement: {
    movement_key: string;
    startedAt: number;
    process: ChildProcessWithoutNullStreams;
    pid: number;  // Store PID for logging and debugging
    killedAt?: number;  // Timestamp when kill signal was sent (to detect orphaned processes)
    ffmpegExited: boolean;  // Track if ffmpeg has exited
    framesSentToML: number;  // Count of frames sent to ML detector
    framesReceivedFromML: number;  // Count of ML results received
    mlTotalProcessingTimeMs: number;  // Sum of all ML processing times
    mlMaxProcessingTimeMs: number;    // Max single frame processing time
    onAllFramesProcessed?: () => void;  // Callback when all frames are processed
} | null = null;

// Max ffmpeg processing time in seconds (default: 300s = 5 minutes)
const FFMPEG_MAX_PROCESSING_TIME_MS = 300 * 1000;

// Regex for HLS segment parsing
const re = new RegExp(`stream([\\d]+).ts`, 'g');

// ============================================================================
// Entry Criteria Helpers (clear checks for maintainability)
// ============================================================================

interface EntryCriteria {
    canRun: boolean;
    reason?: string;
}

/**
 * Check if function is already running (prevents duplicate execution)
 */
function checkNotAlreadyRunning(key: string, tracker: { [key: string]: { inprogress: boolean } }): EntryCriteria {
    if (tracker[key]?.inprogress) {
        return { canRun: false, reason: 'already in progress' };
    }
    return { canRun: true };
}

/**
 * Check if enough time has elapsed since last execution
 */
function checkIntervalElapsed(lastRun: number, intervalMs: number): EntryCriteria {
    const now = Date.now();
    if (now - lastRun < intervalMs) {
        return { canRun: false, reason: `interval not elapsed (${intervalMs - (now - lastRun)}ms remaining)` };
    }
    return { canRun: true };
}

/**
 * Check if startup delay has passed since stream started
 */
function checkStartupDelayPassed(streamStartedAt: number, delayMs: number): EntryCriteria {
    const now = Date.now();
    const remaining = (streamStartedAt + delayMs) - now;
    if (remaining > 0) {
        return { canRun: false, reason: `startup delay (${Math.ceil(remaining / 1000)}s remaining)` };
    }
    return { canRun: true };
}

/**
 * Check if ffmpeg should be running for a camera
 */
function checkFFmpegShouldRun(cacheEntry: CameraCacheEntry): EntryCriteria {
    if (!cacheEntry.ffmpeg_task || cacheEntry.ffmpeg_task.exitCode !== null) {
        return { canRun: false, reason: 'ffmpeg not running' };
    }
    return { canRun: true };
}

// ============================================================================
// Processor Dependencies (injected at initialization)
// ============================================================================

/** Simple logger interface for dependency injection (subset of winston Logger) */
export interface SimpleLogger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

interface ProcessorDependencies {
    logger: SimpleLogger;
    cameradb: any;
    movementdb: any;
    settingsdb: any;
    getCameraCache: () => CameraCache;
    setCameraCache: (key: string, entry: CameraCacheEntry) => void;
    getSettingsCache: () => SettingsCache;
    setSettingsCache: (cache: SettingsCache) => void;
}

let deps: ProcessorDependencies;

export function initProcessor(dependencies: ProcessorDependencies): void {
    deps = dependencies;
    
    // Initialize process-utils with required dependencies
    setLogger(dependencies.logger);
    setDependencies({
        settingsCache: dependencies.getSettingsCache(),
        movementdb: dependencies.movementdb,
        sendImageToMLDetection,
        getShuttingDown: () => _inmem_isShuttingDown
    });
}

export function setShuttingDown(value: boolean): void {
    _inmem_isShuttingDown = value;
}

export function isShuttingDown(): boolean {
    return _inmem_isShuttingDown;
}

export function getMLDetectionProcess(): ChildProcessWithoutNullStreams | null {
    return _inmem_mlDetectionProcess;
}

export function getMovementFFmpegProcesses(): Map<string, ChildProcessWithoutNullStreams> {
    const map = new Map<string, ChildProcessWithoutNullStreams>();
    if (_inmem_currentProcessingMovement) {
        map.set(_inmem_currentProcessingMovement.movement_key, _inmem_currentProcessingMovement.process);
    }
    return map;
}

export function getMovementCloseHandlers(): Map<string, Promise<void>> {
    return _inmem_movementCloseHandlers;
}

/**
 * Reset all in-memory state. Used by tests to ensure isolation.
 */
export function resetProcessorState(): void {
    _inmem_isShuttingDown = false;
    _inmem_mlDetectionProcess = null;
    _inmem_movementCloseHandlers.clear();
    _inmem_mlFrameSentTimes.clear();
    _inmem_pendingUpdates.clear();
    _inmem_lastSSEKeepAlive = 0;
    _inmem_lastDiskCheck = 0;
    _inmem_currentProcessingMovement = null;
    
    // Clear controller state objects
    for (const key of Object.keys(_inmem_controllerFFmpeg_inprogress)) {
        delete _inmem_controllerFFmpeg_inprogress[key];
    }
    for (const key of Object.keys(_inmem_controllerFFmpegConfirmation)) {
        delete _inmem_controllerFFmpegConfirmation[key];
    }
}

// ============================================================================
// Control Loop Functions
// ============================================================================

/**
 * controllerDetector - Manages ML detection process lifecycle (starts/stops Python detector)
 * Entry criteria: None (always runs)
 */
export async function controllerDetector(): Promise<void> {
    const { settings } = deps.getSettingsCache();
    const enabled = settings.detection_enable && !!settings.detection_model;

    // If disabled, stop any running process
    if (!enabled) {
        if (_inmem_mlDetectionProcess && _inmem_mlDetectionProcess.exitCode === null) {
            deps.logger.info('ML detection disabled - stopping process', { pid: _inmem_mlDetectionProcess.pid });
            _inmem_mlDetectionProcess.kill();
            _inmem_mlDetectionProcess = null;
        }
        return;
    }

    // If enabled and not running, start it
    if (!_inmem_mlDetectionProcess || _inmem_mlDetectionProcess.exitCode !== null) {
        try {
            const baseDir = process.env['PWD'];
            const aiDir = `${baseDir}/ai`;
            const cmdArgs = ['-u', '-m', 'detector.detect', '--model_path', settings.detection_model];

            if (settings.detection_target_hw) {
                cmdArgs.push('--target', settings.detection_target_hw);
            }

            const mlProcessor = createMLResultProcessor(processDetectionResult);

            _inmem_mlDetectionProcess = spawnProcess({
                name: 'ML-Detection',
                cmd: 'python3',
                args: cmdArgs,
                cwd: aiDir,
                onStdout: mlProcessor.processStdout,
                onStderr: mlProcessor.processStderr,
                onError: (error: Error) => {
                    deps.logger.error('ML detection process error', { error: error.message });
                },
                onClose: (code: number | null, signal: string | null) => {
                    const isGraceful = code === 0 || code === null || _inmem_isShuttingDown;
                    if (!isGraceful) {
                        deps.logger.error('ML detection process exited unexpectedly', {
                            code,
                            signal,
                            willRestart: 'on next interval'
                        });
                    } else {
                        deps.logger.info('ML detection process closed gracefully', { code, signal });
                    }
                    _inmem_mlDetectionProcess = null;
                }
            });

            deps.logger.info('ML detection pipeline initialized', {
                pid: _inmem_mlDetectionProcess.pid,
                model: settings.detection_model,
                target: settings.detection_target_hw || 'default'
            });
        } catch (error) {
            deps.logger.error('Failed to start ML detection process', { error: String(error) });
            _inmem_mlDetectionProcess = null;
        }
    }
}

/**
 * controllerFFmpeg - Starts/stops ffmpeg streaming process for a camera
 * Entry criteria: Function isn't already running from previous loops
 */
export async function controllerFFmpeg(
    cameraKey: string,
    cameraEntry: CameraEntry,
    task: ChildProcessWithoutNullStreams | undefined
): Promise<ChildProcessWithoutNullStreams | undefined> {
    const name = cameraEntry.name;
    const enabled = cameraEntry.enable_streaming;
    const streamFile = `${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`;

    // Entry criteria: check not already running (use cameraKey for uniqueness, not name)
    const runningCheck = checkNotAlreadyRunning(cameraKey, _inmem_controllerFFmpeg_inprogress);
    if (!runningCheck.canRun) {
        deps.logger.debug('controllerFFmpeg skipped', { name, cameraKey, reason: runningCheck.reason });
        return task;
    }

    // Initialize or update progress tracking
    if (!_inmem_controllerFFmpeg_inprogress[cameraKey]) {
        _inmem_controllerFFmpeg_inprogress[cameraKey] = { inprogress: true, checkFrom: Date.now() };
    } else {
        _inmem_controllerFFmpeg_inprogress[cameraKey].inprogress = true;
    }

    try {
        // No streaming enabled, and process is running then kill it
        if (!enabled) {
            if (task && task.exitCode === null) {
                task.kill();
            }
            return task;
        }

        // Process is running - delegate health check to controllerFFmpegConfirmation
        if (task && task.exitCode === null) {
            return task;
        }

        // Process not running or exited - need to start/restart
        if (task) {
            if (_inmem_isShuttingDown) {
                deps.logger.info('Skipping process restart - shutdown in progress', { name });
                return undefined;
            }
            deps.logger.warn('Process not running - restarting', { name, exitCode: task.exitCode });
        }

        deps.logger.info('Starting streaming process', { name, pid: 'pending' });

        // Determine stream source: explicit streamSource, or construct from ip/passwd
        const streamSource = cameraEntry.streamSource || 
            `rtsp://admin:${cameraEntry.passwd}@${cameraEntry.ip}:554/h264Preview_01_main`;
        const isFileSource = !streamSource.startsWith('rtsp://');
        const isHlsSource = streamSource.endsWith('.m3u8');

        // Build ffmpeg args based on source type
        const cmdArgs: string[] = [];
        
        if (isFileSource) {
            // File source: loop video files (but not HLS - can't loop HLS)
            if (!isHlsSource) {
                cmdArgs.push('-stream_loop', '-1');
            }
            cmdArgs.push('-re');
        } else {
            // RTSP source: TCP transport with buffering
            cmdArgs.push('-rtsp_transport', 'tcp', '-reorder_queue_size', '500', '-max_delay', '500000');
        }
        
        cmdArgs.push(
            '-i', streamSource,
            '-hide_banner',
            '-loglevel', 'error',
            '-vcodec', 'copy',
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '5',
            '-hls_flags', 'append_list',
            '-start_number', ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH).toString(),
            streamFile
        );

        const childProcess = spawnProcess({
            name,
            cmd: '/usr/bin/ffmpeg',
            args: cmdArgs,
            captureOutput: true,
            onStderr: (data: string) => {
                const output = data.toString().trim();
                if (output) {
                    deps.logger.error('ffmpeg streaming error', { name, data: output });
                }
            },
            onClose: (code: number | null, signal: string | null) => {
                if (code !== 0 && code !== null && signal === null && !_inmem_isShuttingDown) {
                    deps.logger.error('Streaming process exited unexpectedly', {
                        name,
                        exitCode: code,
                        willRestart: 'on next cycle'
                    });
                } else if (signal) {
                    deps.logger.info('Streaming process terminated by signal', { name, signal });
                }
            }
        });

        // Verify stream startup (use configurable timeout from settings)
        const streamVerifyTimeout = deps.getSettingsCache().settings.stream_verify_timeout_ms || 10000;
        const verification = await verifyStreamStartup({
            processName: name,
            process: childProcess,
            outputFilePath: streamFile,
            maxWaitTimeMs: streamVerifyTimeout,
            maxFileAgeMs: Math.min(5000, streamVerifyTimeout / 2),
            checkIntervalMs: Math.min(1000, streamVerifyTimeout / 10)
        });

        if (!verification.ready) {
            deps.logger.error('Stream startup failed - killing process', {
                name,
                verification,
                processRunning: childProcess.exitCode === null
            });

            if (childProcess.exitCode === null) {
                try {
                    childProcess.kill();
                    await new Promise((res) => setTimeout(res, 2000));
                    if (childProcess.exitCode === null) {
                        childProcess.kill('SIGKILL');
                    }
                } catch (e) {
                    deps.logger.error('Failed to kill failed stream process', { name, error: String(e) });
                }
            }
            return undefined;
        }

        // Mark stream start time and reset confirmation state
        const cameraCache = deps.getCameraCache();
        if (cameraCache[cameraKey]) {
            deps.setCameraCache(cameraKey, {
                ...cameraCache[cameraKey],
                streamStartedAt: Date.now()
            });
        }
        _inmem_controllerFFmpegConfirmation[cameraKey] = { lastCheck: 0, confirmed: false };

        return childProcess;
    } finally {
        _inmem_controllerFFmpeg_inprogress[cameraKey].inprogress = false;
    }
}

/**
 * controllerFFmpegConfirmation - Ensures ffmpeg is running successfully and generating expected output
 * Entry criteria:
 *   - Function isn't already running from previous loops
 *   - FFmpeg is supposed to be running
 *   - Only run first time after start, then every 5 seconds
 */
export async function controllerFFmpegConfirmation(
    cameraKey: string,
    cameraEntry: CameraEntry,
    task: ChildProcessWithoutNullStreams | undefined
): Promise<{ healthy: boolean; shouldRestart: boolean }> {
    const name = cameraEntry.name;
    const streamFile = `${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`;
    const checkIntervalMs = 5000; // Check every 5 seconds

    // Entry criteria: check if ffmpeg should be running
    const ffmpegCheck = checkFFmpegShouldRun(deps.getCameraCache()[cameraKey]);
    if (!ffmpegCheck.canRun) {
        return { healthy: false, shouldRestart: false };
    }

    // Entry criteria: check interval (first run or every 5 seconds) - use cameraKey for uniqueness
    const confirmState = _inmem_controllerFFmpegConfirmation[cameraKey] || { lastCheck: 0, confirmed: false };
    if (confirmState.confirmed) {
        const intervalCheck = checkIntervalElapsed(confirmState.lastCheck, checkIntervalMs);
        if (!intervalCheck.canRun) {
            return { healthy: true, shouldRestart: false };
        }
    }

    // Update last check time
    _inmem_controllerFFmpegConfirmation[cameraKey] = { ...confirmState, lastCheck: Date.now() };

    try {
        const { mtimeMs, size } = await fs.stat(streamFile);
        const lastUpdatedAgo = Date.now() - mtimeMs;

        if (size === 0) {
            deps.logger.warn('Process producing empty file - killing', { name, cameraKey, file: streamFile, size });
            task?.kill();
            return { healthy: false, shouldRestart: true };
        }

        if (lastUpdatedAgo > 10000 /* 10 seconds */) {
            deps.logger.warn('Process hung - killing', { name, cameraKey, file: streamFile, lastUpdate: `${lastUpdatedAgo}ms` });
            task?.kill();
            return { healthy: false, shouldRestart: true };
        }

        // Successfully confirmed
        if (!confirmState.confirmed) {
            deps.logger.info('Stream confirmed healthy', { name, cameraKey, fileAge: `${lastUpdatedAgo}ms` });
        }
        _inmem_controllerFFmpegConfirmation[cameraKey] = { lastCheck: Date.now(), confirmed: true };
        return { healthy: true, shouldRestart: false };

    } catch (e) {
        deps.logger.warn('Cannot access process output - killing', { name, cameraKey, file: streamFile, error: String(e) });
        task?.kill();
        return { healthy: false, shouldRestart: true };
    }
}

/**
 * detectCameraMovement - Detects movement from camera API and records it
 * Entry criteria:
 *   - Only run if configured interval has elapsed
 *   - Only run after secMovementStartupDelay since ffmpeg started/restarted
 */
export async function detectCameraMovement(cameraKey: string): Promise<void> {
    const cameraCache = deps.getCameraCache();
    const { movementDetectionStatus, cameraEntry } = cameraCache[cameraKey];

    // Circuit breaker
    const control = { fn_not_finished: false, fail: false, check_after: 0 };
    const { fn_not_finished, fail, check_after } = movementDetectionStatus?.control || control;

    if (fn_not_finished || (fail && (!check_after || check_after > Date.now()))) {
        deps.logger.debug('detectCameraMovement: skipped - already in progress or in failure backoff', {
            camera: cameraEntry.name,
            cameraKey,
            fn_not_finished,
            fail,
            check_after: check_after ? new Date(check_after).toISOString() : null
        });
        return;
    }

    // Set flag to prevent concurrent execution
    deps.setCameraCache(cameraKey, {
        ...cameraCache[cameraKey],
        movementDetectionStatus: {
            ...movementDetectionStatus,
            control: { fail, check_after, fn_not_finished: true }
        }
    });

    deps.logger.debug('detectCameraMovement: started', {
        camera: cameraEntry.name,
        cameraKey,
        current_movement_key: movementDetectionStatus?.current_movement_key
    });

    const { ip, passwd, motionUrl } = cameraEntry;

    try {
        const { current_movement_key } = movementDetectionStatus || { current_movement_key: undefined };

        // Use motionUrl if provided, otherwise construct from ip/passwd
        const apiUrl = motionUrl || `http://${ip}/api.cgi?cmd=GetMdState&user=admin&password=${passwd}`;

        // Fetch with timeout
        const fetchAndReadPromise = (async () => {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.text();
        })();

        const timeoutPromise = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout after 5000ms')), 5000)
        );

        const body_json = await Promise.race([fetchAndReadPromise, timeoutPromise]);

        // Parse the JSON response
        const body = JSON.parse(body_json);
        const movementState = body[0]?.value?.state;

        deps.logger.debug('detectCameraMovement: API result', {
            camera: cameraEntry.name,
            state: movementState === 1 ? 'MOVEMENT' : 'NO_MOVEMENT',
            rawState: movementState
        });

        if (body[0]?.error) {
            throw new Error(`detectCameraMovement: Camera API error: ${JSON.stringify(body[0].error)}`);
        }

        const hasMovement = movementState === 1;

        if (hasMovement) {
            await handleMovementDetected(cameraKey, current_movement_key, cameraEntry, control);
        } else {
            await handleNoMovement(cameraKey, current_movement_key, cameraEntry, movementDetectionStatus, control);
        }

    } catch (error) {
        const filtersensitive = String(error).replace(new RegExp(passwd || '', 'g'), '****');
        deps.logger.error('detectCameraMovement failed', {
            camera: cameraEntry.name,
            error: filtersensitive
        });

        deps.setCameraCache(cameraKey, {
            ...deps.getCameraCache()[cameraKey],
            movementDetectionStatus: {
                ...movementDetectionStatus,
                status: `Detection failed: ${filtersensitive}`,
                control: {
                    fail: true,
                    check_after: Date.now() + 10000,
                    fn_not_finished: false
                }
            }
        });
    } finally {
        // Always reset fn_not_finished flag
        const currentCache = deps.getCameraCache()[cameraKey];
        if (currentCache?.movementDetectionStatus) {
            currentCache.movementDetectionStatus.control.fn_not_finished = false;
        }
    }
}

/**
 * Handle when movement is detected
 */
async function handleMovementDetected(
    cameraKey: string,
    current_movement_key: string | undefined,
    cameraEntry: CameraEntry,
    control: { fn_not_finished: boolean; fail: boolean; check_after?: number }
): Promise<void> {
    const cameraCache = deps.getCameraCache();

    if (!current_movement_key) {
        // New movement detected
        const startDate = Date.now();
        const movement_key = encodeMovementKey(startDate);

        deps.logger.info('detectCameraMovement: New movement, create movement record', {
            camera: cameraEntry.name, movement_key
        });

        let movementEntry: MovementEntry = {
            cameraKey,
            startDate,
            startSegment: null as any,
            seconds: 0,
            pollCount: 0,
            consecutivePollsWithoutMovement: 0,
            processing_state: 'pending',
            detection_started_at: startDate  // Track when detection started
        };

        // Get segment information from HLS playlist
        const { disk, folder } = cameraEntry;
        const filepath = `${disk}/${folder}/stream.m3u8`;

        let startSegment: number;
        let lhs_seg_duration_seq: number;

        try {
            const hls = (await fs.readFile(filepath)).toString();
            const hls_segments = [...hls.matchAll(re)].map(m => m[1]);
            const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/);
            lhs_seg_duration_seq = parseInt(targetduration && targetduration.length > 1 ? targetduration[1] : "2");

            const segmentsToLookBack = Math.ceil(cameraEntry.mSPollFrequency / (lhs_seg_duration_seq * 1000));
            startSegment = parseInt(hls_segments[hls_segments.length - 1]) - segmentsToLookBack + 1;
            const playlist_last_segment = parseInt(hls_segments[hls_segments.length - 1]);

            movementEntry = {
                ...movementEntry,
                startSegment,
                lhs_seg_duration_seq,
                playlist_last_segment
            };
        } catch (error) {
            deps.logger.error('Failed to read HLS playlist', {
                camera: cameraEntry.name,
                movement_key,
                error: String(error)
            });

            await deps.movementdb.put(movement_key, {
                ...movementEntry,
                processing_state: 'failed',
                processing_error: `Failed to read HLS playlist: ${String(error)}`,
                processing_completed_at: Date.now()
            });
            return;
        }

        // Setup frame extraction
        const settingsCache = deps.getSettingsCache();
        const framesPath = getFramesPath(settingsCache.settings, disk, folder);
        await ensureDir(framesPath);

        // Create live HLS playlist
        const boundedPlaylistPath = `${framesPath}/mov${movement_key}.m3u8`;

        const hls = (await fs.readFile(filepath)).toString();
        const hls_segments = [...hls.matchAll(re)].map(m => m[1]);
        const currentLatestSegment = parseInt(hls_segments[hls_segments.length - 1]);

        const playlistLines = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${lhs_seg_duration_seq}`,
            '#EXT-X-MEDIA-SEQUENCE:' + startSegment
        ];

        for (let i = startSegment; i <= currentLatestSegment; i++) {
            playlistLines.push(`#EXTINF:${lhs_seg_duration_seq}.0,`);
            playlistLines.push(`${disk}/${folder}/stream${i}.ts`);
        }

        await fs.writeFile(boundedPlaylistPath, playlistLines.join('\n'));

        await deps.movementdb.put(movement_key, {
            ...movementEntry,
            playlist_path: boundedPlaylistPath,
            playlist_last_segment: currentLatestSegment,
        });

        // Update cache
        deps.setCameraCache(cameraKey, {
            ...cameraCache[cameraKey],
            movementDetectionStatus: {
                current_movement_key: movement_key,
                status: 'Movement detected',
                control: { ...control, fn_not_finished: false }
            }
        });

        // Notify SSE clients
        sseManager.broadcastMovementUpdate({
            type: 'movement_new',
            movement: formatMovementForSSE(movement_key, movementEntry)
        });

    } else {
        // Movement continuation
        deps.logger.info('detectCameraMovement: Continuation of existing movement', {
            camera: cameraEntry.name, current_movement_key
        });

        const existing = await deps.movementdb.get(current_movement_key);
        const now = Date.now();
        const elapsedSeconds = Math.floor((now - existing.startDate) / 1000);
        const secMaxSingleMovement = cameraEntry.secMaxSingleMovement || 600;

        // Track the latest segment for proper update at the end
        let latestPlaylistSegment = existing.playlist_last_segment;

        // Update playlist with new segments
        if (existing.playlist_path && existing.playlist_last_segment) {
            try {
                const hls = (await fs.readFile(`${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`)).toString();
                const hls_segments = [...hls.matchAll(re)].map(m => m[1]);
                const currentSegment = parseInt(hls_segments[hls_segments.length - 1]);

                if (currentSegment > existing.playlist_last_segment) {
                    const newSegments: string[] = [];
                    for (let i = existing.playlist_last_segment + 1; i <= currentSegment; i++) {
                        newSegments.push(`#EXTINF:${existing.lhs_seg_duration_seq}.0,`);
                        newSegments.push(`${cameraEntry.disk}/${cameraEntry.folder}/stream${i}.ts`);
                    }

                    await fs.appendFile(existing.playlist_path, '\n' + newSegments.join('\n'));
                    
                    // Track the updated segment for the final db write
                    latestPlaylistSegment = currentSegment;
                }
            } catch (e) {
                deps.logger.warn('Failed to update playlist', {
                    camera: cameraEntry.name,
                    movement_key: current_movement_key,
                    error: String(e)
                });
            }
        }

        if (elapsedSeconds > secMaxSingleMovement) {
            // Max duration reached - finalize
            await finalizeMovement(cameraKey, current_movement_key, existing, elapsedSeconds, cameraEntry, control, 'max duration');
        } else {
            // Normal continuation - single db write with all updates including playlist_last_segment
            const updated: MovementEntry = {
                ...existing,
                seconds: elapsedSeconds,
                pollCount: (existing.pollCount || 0) + 1,
                consecutivePollsWithoutMovement: 0,
                playlist_last_segment: latestPlaylistSegment  // Include updated segment to avoid overwrite
            };

            await deps.movementdb.put(current_movement_key, updated);

            deps.setCameraCache(cameraKey, {
                ...deps.getCameraCache()[cameraKey],
                movementDetectionStatus: {
                    ...deps.getCameraCache()[cameraKey].movementDetectionStatus,
                    status: 'Movement continuing',
                    control: { ...control, fn_not_finished: false }
                }
            });
        }
    }
}

/**
 * Handle when no movement is detected
 */
async function handleNoMovement(
    cameraKey: string,
    current_movement_key: string | undefined,
    cameraEntry: CameraEntry,
    movementDetectionStatus: any,
    control: { fn_not_finished: boolean; fail: boolean; check_after?: number }
): Promise<void> {
    if (current_movement_key) {
        const existing = await deps.movementdb.get(current_movement_key);
        const now = Date.now();
        const elapsedSeconds = Math.floor((now - existing.startDate) / 1000);
        const consecutivePollsWithoutMovement = (existing.consecutivePollsWithoutMovement || 0) + 1;

        const pollsWithoutMovement = cameraEntry.pollsWithoutMovement;
        const secMaxSingleMovement = cameraEntry.secMaxSingleMovement || 600;
        const shouldEndMovement =
            pollsWithoutMovement === 0 ||
            consecutivePollsWithoutMovement >= pollsWithoutMovement ||
            elapsedSeconds > secMaxSingleMovement;

        deps.logger.info('detectCameraMovement: No reported camera movement', {
            camera: cameraEntry.name,
            current_movement_key,
            shouldEndMovement,
            consecutivePollsWithoutMovement,
            elapsedSeconds
        });

        const updated: MovementEntry = {
            ...existing,
            seconds: elapsedSeconds,
            consecutivePollsWithoutMovement
        };

        await deps.movementdb.put(current_movement_key, updated);

        if (shouldEndMovement) {
            await finalizeMovement(cameraKey, current_movement_key, updated, elapsedSeconds, cameraEntry, control, 'no movement');
        }
    } else {
        // No movement and no ongoing movement
        if (movementDetectionStatus?.status !== 'No movement') {
            deps.setCameraCache(cameraKey, {
                ...deps.getCameraCache()[cameraKey],
                movementDetectionStatus: {
                    ...movementDetectionStatus,
                    status: 'No movement',
                    control: { ...control, fn_not_finished: false }
                }
            });
        } else if (movementDetectionStatus) {
            movementDetectionStatus.control.fn_not_finished = false;
        }
    }
}

/**
 * Finalize a movement (end it and notify clients)
 */
async function finalizeMovement(
    cameraKey: string,
    movement_key: string,
    movement: MovementEntry,
    elapsedSeconds: number,
    cameraEntry: CameraEntry,
    control: any,
    reason: string
): Promise<void> {
    deps.logger.info(`Movement ended - ${reason}`, {
        camera: cameraEntry.name,
        movement_key,
        duration: elapsedSeconds
    });

    // Update movement with detection_ended_at timestamp
    const detectionEndedAt = Date.now();
    const updatedMovement = {
        ...movement,
        seconds: elapsedSeconds,
        detection_ended_at: detectionEndedAt
    };
    await deps.movementdb.put(movement_key, updatedMovement);

    // Finalize playlist with ENDLIST
    if (movement.playlist_path) {
        try {
            const playlistContent = await fs.readFile(movement.playlist_path, 'utf-8');
            if (!playlistContent.includes('#EXT-X-ENDLIST')) {
                await fs.appendFile(movement.playlist_path, '\n#EXT-X-ENDLIST\n');
                deps.logger.info('Finalized playlist with ENDLIST', {
                    camera: cameraEntry.name,
                    movement_key
                });
            }
        } catch (e) {
            deps.logger.warn('Failed to finalize playlist', {
                camera: cameraEntry.name,
                movement_key,
                error: String(e)
            });
        }
    }

    // Update cache
    deps.setCameraCache(cameraKey, {
        ...deps.getCameraCache()[cameraKey],
        movementDetectionStatus: {
            current_movement_key: undefined,
            status: 'No movement',
            control: { ...control, fn_not_finished: false }
        }
    });

    // Notify SSE clients
    sseManager.broadcastMovementUpdate({
        type: 'movement_complete',
        movement: formatMovementForSSE(movement_key, movement)
    });
}

/**
 * triggerProcessMovement - Processes pending movements with ML detection
 * 
 * Idempotent function called by the control loop. Processes ONE movement at a time:
 * 1. If already processing, check for timeout and return
 * 2. Find the oldest 'pending' movement with a finalized playlist
 * 3. Start ffmpeg to extract frames
 * 4. On ffmpeg close, mark movement as completed/failed
 * 
 * Entry criteria: Called by control loop, processes movements sequentially
 */
export async function triggerProcessMovement(): Promise<void> {
    // If already processing a movement, check for timeout
    if (_inmem_currentProcessingMovement) {
        const elapsed = Date.now() - _inmem_currentProcessingMovement.startedAt;
        const { movement_key, process, pid, killedAt } = _inmem_currentProcessingMovement;
        
        // If we've already sent kill signal, check if enough time has passed
        if (killedAt) {
            const timeSinceKill = Date.now() - killedAt;
            // If process hasn't exited after 10 seconds post-kill, force clear tracking
            // The orphaned process will be handled by OS or manual cleanup
            if (timeSinceKill > 10000) {
                deps.logger.error('triggerProcessMovement: ffmpeg still running after kill, forcibly clearing tracking', {
                    movement_key,
                    pid,
                    timeSinceKill_ms: timeSinceKill
                });
                _inmem_currentProcessingMovement = null;
            }
            return; // Still waiting for killed process to exit
        }
        
        if (elapsed > FFMPEG_MAX_PROCESSING_TIME_MS) {
            deps.logger.warn('triggerProcessMovement: ffmpeg timeout, killing process', {
                movement_key,
                pid,
                elapsed_ms: elapsed,
                max_ms: FFMPEG_MAX_PROCESSING_TIME_MS
            });
            
            // Mark that we've initiated kill - don't clear tracking until process exits or force timeout
            _inmem_currentProcessingMovement.killedAt = Date.now();
            
            try {
                process.kill('SIGTERM');
                // Force kill after 2 seconds if still running
                setTimeout(() => {
                    try {
                        if (process.exitCode === null) {
                            deps.logger.warn('triggerProcessMovement: SIGTERM did not work, sending SIGKILL', {
                                movement_key,
                                pid
                            });
                            process.kill('SIGKILL');
                        }
                    } catch (e) {
                        // Process already terminated
                    }
                }, 2000);
            } catch (e) {
                deps.logger.error('triggerProcessMovement: Failed to kill timed out ffmpeg', {
                    movement_key,
                    pid,
                    error: String(e)
                });
            }
            
            // Mark as failed due to timeout
            try {
                const m = await deps.movementdb.get(movement_key);
                const updatedMovement = {
                    ...m,
                    processing_state: 'failed' as const,
                    detection_status: 'failed',
                    processing_completed_at: Date.now(),
                    processing_error: `Processing timeout after ${Math.floor(elapsed / 1000)}s`
                };
                await deps.movementdb.put(movement_key, updatedMovement);
                
                if (sseManager.getClientCount() > 0) {
                    sseManager.broadcastMovementUpdate({
                        type: 'movement_update',
                        movement: formatMovementForSSE(movement_key, updatedMovement)
                    });
                }
            } catch (e) {
                deps.logger.error('triggerProcessMovement: Failed to mark timed out movement as failed', {
                    movement_key,
                    pid,
                    error: String(e)
                });
            }
            
            // DON'T clear tracking here - wait for onClose or force timeout
        }
        
        // Still processing (or waiting for killed process to exit), don't start another
        return;
    }
    
    // Find the oldest pending movement with a playlist
    let nextMovement: { key: string; movement: MovementEntry; cameraEntry: CameraEntry } | null = null;
    
    try {
        for await (const [encodedKey, movement] of deps.movementdb.iterator()) {
            // Skip non-pending movements
            if (movement.processing_state !== 'pending') {
                continue;
            }
            
            // Must have a playlist path
            if (!movement.playlist_path) {
                deps.logger.debug('triggerProcessMovement: Skipping movement without playlist', { 
                    movement_key: encodedKey 
                });
                continue;
            }
            
            // Verify playlist file exists
            try {
                await fs.access(movement.playlist_path);
            } catch (e) {
                deps.logger.warn('triggerProcessMovement: Playlist file not accessible', {
                    movement_key: encodedKey,
                    playlist_path: movement.playlist_path,
                    error: String(e)
                });
                continue;
            }
            
            // Get camera entry
            const cameraCache = deps.getCameraCache();
            const cameraEntry = cameraCache[movement.cameraKey]?.cameraEntry;
            if (!cameraEntry) {
                deps.logger.warn('triggerProcessMovement: Camera not found for movement', {
                    movement_key: encodedKey,
                    cameraKey: movement.cameraKey
                });
                continue;
            }
            
            nextMovement = { key: encodedKey, movement, cameraEntry };
            break; // Take the first (oldest) pending movement
        }
    } catch (e) {
        deps.logger.error('triggerProcessMovement: Failed to iterate movements', { error: String(e) });
        return;
    }
    
    if (!nextMovement) {
        // No pending movements to process
        return;
    }
    
    const { key: movement_key, movement, cameraEntry } = nextMovement;
    
    // Setup paths
    const settingsCache = deps.getSettingsCache();
    const framesPath = getFramesPath(settingsCache.settings, cameraEntry.disk, cameraEntry.folder);
    await ensureDir(framesPath);
    
    // Calculate max wait time based on camera's max single movement setting
    const maxMovementSeconds = cameraEntry.secMaxSingleMovement || 90;
    
    // ffmpeg args with live HLS support - will wait for new segments until ENDLIST or timeout
    // For local file HLS, we need to force the HLS demuxer and enable live mode
    // Add hard duration limit to prevent ffmpeg from hanging indefinitely on malformed/incomplete playlists
    const hardDurationLimit = maxMovementSeconds + 60;  // Allow extra time for processing but enforce limit
    const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'info',
        '-f', 'hls',                        // Force HLS demuxer for proper live handling
        '-live_start_index', '0',           // Start from first segment in playlist
        '-allowed_extensions', 'ALL',       // Allow .ts segments with absolute paths
        '-rw_timeout', `${(maxMovementSeconds + 30) * 1000000}`,  // Microseconds timeout for reading
        '-progress', 'pipe:1',
        '-i', movement.playlist_path!,
        '-t', `${hardDurationLimit}`,       // Hard OUTPUT duration limit (after -i) to prevent indefinite processing
        '-vf', 'fps=2,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2',
        `${framesPath}/mov${movement_key}_%04d.jpg`
    ];

    deps.logger.info('triggerProcessMovement: Starting', {
        camera: cameraEntry.name,
        movement: movement_key,
        playlist_path: movement.playlist_path
    });

    // Update movement to processing state
    const updatedMovement = {
        ...movement,
        processing_state: 'processing' as const,
        processing_started_at: Date.now(),
        detection_status: 'extracting'
    };
    await deps.movementdb.put(movement_key, updatedMovement);

    if (sseManager.getClientCount() > 0) {
        sseManager.broadcastMovementUpdate({
            type: 'movement_update',
            movement: formatMovementForSSE(movement_key, updatedMovement)
        });
    }

    // Create frame processor
    const frameProcessor = createFFmpegFrameProcessor(movement_key, framesPath, cameraEntry.name);

    // Spawn ffmpeg
    const ffmpeg = spawnProcess({
        name: `ffmpeg-${cameraEntry.name}-mov${movement_key}`,
        cmd: '/usr/bin/ffmpeg',
        args: ffmpegArgs,
        onStdout: frameProcessor.processStdout,
        onStderr: frameProcessor.processStderr,
        onError: (error: Error) => {
            deps.logger.error('ffmpeg frame extraction error', {
                camera: cameraEntry.name,
                movement: movement_key,
                error: error.message
            });
        },
        onClose: (code: number | null, signal: string | null) => {
            const isGraceful = code === 0 || code === 255 || signal === 'SIGTERM' || signal === 'SIGKILL' || _inmem_isShuttingDown;
            const totalFrames = frameProcessor.getLastFrameNumber();

            deps.logger.info('ffmpeg frame extraction complete', {
                camera: cameraEntry.name,
                movement: movement_key,
                exitCode: code,
                signal,
                totalFrames,
                graceful: isGraceful
            });

            // Mark ffmpeg as exited - don't clear tracking yet
            if (_inmem_currentProcessingMovement && 
                _inmem_currentProcessingMovement.movement_key === movement_key) {
                _inmem_currentProcessingMovement.ffmpegExited = true;
                
                const { framesSentToML, framesReceivedFromML } = _inmem_currentProcessingMovement;
                deps.logger.info('ffmpeg exited, waiting for ML results', {
                    movement_key,
                    framesSent: framesSentToML,
                    framesReceived: framesReceivedFromML,
                    pending: framesSentToML - framesReceivedFromML
                });
                
                // Set up the finalization callback
                _inmem_currentProcessingMovement.onAllFramesProcessed = async () => {
                    // Capture ML stats before clearing tracking
                    const mlStats = _inmem_currentProcessingMovement ? {
                        frames_sent_to_ml: _inmem_currentProcessingMovement.framesSentToML,
                        frames_received_from_ml: _inmem_currentProcessingMovement.framesReceivedFromML,
                        ml_total_processing_time_ms: _inmem_currentProcessingMovement.mlTotalProcessingTimeMs,
                        ml_max_processing_time_ms: _inmem_currentProcessingMovement.mlMaxProcessingTimeMs
                    } : null;
                    
                    // Wrap async logic in a tracked promise for graceful shutdown
                    const closeHandler = async () => {
                        // Clear tracking now that we're finalizing
                        _inmem_currentProcessingMovement = null;

                        // Mark as completed or failed (unless already marked by timeout handler)
                        try {
                            const m = await deps.movementdb.get(movement_key);
                            
                            // If already marked as failed/completed (e.g., by timeout handler), skip
                            if (m.processing_state === 'completed' || m.processing_state === 'failed') {
                                deps.logger.debug('triggerProcessMovement: Movement already finalized', {
                                    movement_key,
                                    processing_state: m.processing_state
                                });
                                return;
                            }
                            
                            const hasFailed = totalFrames === 0 || (!isGraceful && code !== 0);

                            let errorMsg = '';
                            if (hasFailed) {
                                const stderrErrors = frameProcessor.getErrors();
                                if (stderrErrors.length > 0) {
                                    errorMsg = stderrErrors[0];
                                } else if (totalFrames === 0) {
                                    errorMsg = 'No frames extracted';
                                } else {
                                    errorMsg = `ffmpeg exited with code ${code}`;
                                }
                            }

                            const finalMovement = {
                                ...m,
                                processing_state: hasFailed ? 'failed' as const : 'completed' as const,
                                detection_status: hasFailed ? 'failed' : 'complete',
                                processing_completed_at: Date.now(),
                                ...(hasFailed && { processing_error: errorMsg }),
                                // Include ML processing stats
                                ...(mlStats && {
                                    frames_sent_to_ml: mlStats.frames_sent_to_ml,
                                    frames_received_from_ml: mlStats.frames_received_from_ml,
                                    ml_total_processing_time_ms: mlStats.ml_total_processing_time_ms,
                                    ml_max_processing_time_ms: mlStats.ml_max_processing_time_ms
                                })
                            };
                            await deps.movementdb.put(movement_key, finalMovement);

                            // Broadcast completion state to UI
                            if (sseManager.getClientCount() > 0) {
                                sseManager.broadcastMovementUpdate({
                                    type: 'movement_update',
                                    movement: formatMovementForSSE(movement_key, finalMovement)
                                });
                            }

                            if (hasFailed) {
                                deps.logger.warn('Movement processing failed', {
                                    camera: cameraEntry.name,
                                    movement_key,
                                    totalFrames,
                                    exitCode: code,
                                    graceful: isGraceful
                                });
                            } else {
                                deps.logger.info('Movement processing completed', {
                                    camera: cameraEntry.name,
                                    movement_key
                                });
                            }
                        } catch (error) {
                            deps.logger.error('Failed to mark movement as completed', {
                                camera: cameraEntry.name,
                                movement_key,
                                error: String(error)
                            });
                        } finally {
                            // Remove from close handlers tracking
                            _inmem_movementCloseHandlers.delete(movement_key);
                        }
                    };

                    // Track this close handler promise
                    const promise = closeHandler();
                    _inmem_movementCloseHandlers.set(movement_key, promise);
                };
                
                // Check if all frames already processed (e.g., no frames sent, or all already received)
                checkAndFinalizeMovement();
            } else {
                // Movement tracking was already cleared (e.g., by timeout), just log
                deps.logger.debug('ffmpeg closed but movement tracking already cleared', {
                    movement_key
                });
            }
        }
    });

    // Track the process with frame counters
    _inmem_currentProcessingMovement = {
        movement_key,
        startedAt: Date.now(),
        process: ffmpeg,
        pid: ffmpeg.pid!,
        ffmpegExited: false,
        framesSentToML: 0,
        framesReceivedFromML: 0,
        mlTotalProcessingTimeMs: 0,
        mlMaxProcessingTimeMs: 0
    };
}

/**
 * sseKeepAlive - Send keep-alive to SSE clients
 * Entry criteria: Only run at 30 second intervals
 */
export function sseKeepAlive(): void {
    const intervalMs = 30000;

    const intervalCheck = checkIntervalElapsed(_inmem_lastSSEKeepAlive, intervalMs);
    if (!intervalCheck.canRun) {
        return;
    }

    _inmem_lastSSEKeepAlive = Date.now();

    if (sseManager.getClientCount() > 0) {
        sseManager.sendKeepAlive();
    }
}

/**
 * clearDownDisk - Removes old recordings when disk usage exceeds threshold
 * Entry criteria: Only run at configured interval
 */
export async function controllerClearDownDisk(): Promise<void> {
    const settingsCache = deps.getSettingsCache();
    const { settings, status } = settingsCache;

    if (status.nextCheckInMinutes === 0) {
        deps.setSettingsCache({
            ...settingsCache,
            status: { ...status, nextCheckInMinutes: settings.disk_cleanup_interval }
        });

        if (settings.disk_cleanup_interval > 0 && settings.disk_base_dir) {
            try {
                const cameraCache = deps.getCameraCache();
                const cameraKeys = Object.keys(cameraCache).filter(
                    c => (!cameraCache[c].cameraEntry.delete) && cameraCache[c].cameraEntry.enable_streaming
                );

                const cameraFolders = cameraKeys.map(key => `${settings.disk_base_dir}/${cameraCache[key].cameraEntry.folder}`);
                const mlFramesFolder = settings.detection_frames_path
                    ? `${settings.disk_base_dir}/${settings.detection_frames_path}`.replace(/\/+/g, '/')
                    : null;

                const foldersToClean = mlFramesFolder && !cameraFolders.includes(mlFramesFolder)
                    ? [...cameraFolders, mlFramesFolder]
                    : cameraFolders;

                const diskres = await diskCheck(settings.disk_base_dir, foldersToClean, settings.disk_cleanup_capacity);
                deps.logger.info('Disk check complete', diskres);

                if (diskres.revmovedMBTotal > 0) {
                    const mostRecentctimMs = Object.keys(diskres.folderStats).reduce(
                        (acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs
                            ? (diskres.folderStats[cur].lastRemovedctimeMs > acc ? diskres.folderStats[cur].lastRemovedctimeMs : acc)
                            : acc,
                        0
                    );

                    if (mostRecentctimMs > 0) {
                        const keytoDeleteTo = encodeMovementKey((mostRecentctimMs / 1000 | 0) - MOVEMENT_KEY_EPOCH);
                        const deleteKeys: string[] = [];

                        for await (const [encodedKey, value] of deps.movementdb.iterator({ lte: keytoDeleteTo })) {
                            if (cameraKeys.includes(value.cameraKey)) {
                                deleteKeys.push(encodedKey);
                            }
                        }

                        if (deleteKeys.length > 0) {
                            deps.logger.info('Deleting old movements', { count: deleteKeys.length });
                            await deps.movementdb.batch(deleteKeys.map((k: string) => ({ type: 'del', key: k })) as any);
                        }
                    }
                }

                deps.setSettingsCache({
                    ...settingsCache,
                    status: { ...status, fail: false, error: '', lastChecked: new Date() }
                });
            } catch (e: any) {
                deps.logger.error('Disk cleanup error', { error: String(e) });
                deps.setSettingsCache({
                    ...settingsCache,
                    status: { ...status, fail: true, error: e?.message, lastChecked: new Date() }
                });
            }
        }
    } else {
        deps.setSettingsCache({
            ...settingsCache,
            status: { ...status, nextCheckInMinutes: status.nextCheckInMinutes - 1 }
        });
    }
}

// ============================================================================
// ML Detection Helpers
// ============================================================================

/**
 * Send image path to ML detection process
 */
function sendImageToMLDetection(imagePath: string, movement_key: number): void {
    if (_inmem_mlDetectionProcess && _inmem_mlDetectionProcess.stdin && !_inmem_mlDetectionProcess.killed) {
        try {
            const imageName = imagePath.split('/').pop() || imagePath;
            _inmem_mlFrameSentTimes.set(imageName, Date.now());
            _inmem_mlDetectionProcess.stdin.write(`${imagePath}\n`);
            
            // Track frames sent for the current processing movement
            if (_inmem_currentProcessingMovement && 
                _inmem_currentProcessingMovement.movement_key === String(movement_key)) {
                _inmem_currentProcessingMovement.framesSentToML++;
            }
            
            deps.logger.info('Frame sent to ML detector', { frame: imageName, movement: movement_key, path: imagePath });
        } catch (error) {
            deps.logger.warn('Failed to send image to ML detection', { error: String(error) });
        }
    } else {
        deps.logger.warn('ML detection process not available', {
            processExists: _inmem_mlDetectionProcess !== null,
            stdinExists: _inmem_mlDetectionProcess?.stdin !== undefined,
            processKilled: _inmem_mlDetectionProcess?.killed
        });
    }
}

/**
 * Process detection result from ML pipeline
 */
async function processDetectionResult(line: string): Promise<void> {
    try {
        const result = JSON.parse(line);

        if (!result.image || !result.detections) {
            deps.logger.warn('Invalid detection result format', { line });
            return;
        }

        const imagePath = result.image;
        const imageName = imagePath.split('/').pop() || imagePath;
        const movementKeyMatch = imageName.match(/^mov(\d+)_/);
        if (!movementKeyMatch) {
            deps.logger.warn('Detection received for image with invalid filename format', { image: imageName });
            return;
        }

        const movement_key = movementKeyMatch[1];

        // Calculate processing time
        const sentTime = _inmem_mlFrameSentTimes.get(imageName);
        const processingTimeMs = sentTime ? Date.now() - sentTime : null;
        if (sentTime) {
            _inmem_mlFrameSentTimes.delete(imageName);
        }

        // Skip if update already in progress
        if (_inmem_pendingUpdates.has(parseInt(movement_key))) {
            deps.logger.debug('Detection update already pending', { movement: movement_key, frame: imageName });
            setTimeout(() => processDetectionResult(line), 50);
            return;
        }

        _inmem_pendingUpdates.add(parseInt(movement_key));

        try {
            const movement: MovementEntry = await deps.movementdb.get(encodeMovementKey(parseInt(movement_key)));
            if (!movement) throw new Error(`Movement ${movement_key} not found in database`);

            const existingTags = movement.detection_output?.tags || [];
            const tagsMap: { [key: string]: MLTag } = {};
            existingTags.forEach((tag: MLTag) => {
                tagsMap[tag.tag] = tag;
            });

            if (result.detections && result.detections.length > 0) {
                deps.logger.info('Detection received from ML', {
                    frame: imageName,
                    movement: movement_key,
                    processingTime: processingTimeMs ? `${processingTimeMs}ms` : 'unknown',
                    objects: result.detections.map((d: any) => `${d.object}(${(d.probability * 100).toFixed(1)}%)`).join(', '),
                    existingTags: existingTags.length
                });
            }

            // Process detections
            for (const detection of result.detections) {
                const objectType = detection.object;
                const probability = detection.probability;

                const existing = tagsMap[objectType];
                if (!existing || probability > existing.maxProbability) {
                    tagsMap[objectType] = {
                        tag: objectType,
                        maxProbability: Math.round(probability * 100) / 100,
                        count: existing ? existing.count + 1 : 1,
                        maxProbabilityImage: imageName
                    };
                } else {
                    existing.count++;
                }
            }

            const updatedTags: MLTag[] = Object.values(tagsMap)
                .sort((a, b) => b.maxProbability - a.maxProbability);

            const updatedMovement = {
                ...movement,
                detection_status: undefined,
                detection_output: { tags: updatedTags }
            };

            await deps.movementdb.put(encodeMovementKey(parseInt(movement_key)), updatedMovement);

            deps.logger.info('Movement updated with ML results', {
                movement: movement_key,
                tagCount: updatedTags.length,
                tags: updatedTags.map(t => `${t.tag}(${(t.maxProbability * 100).toFixed(1)}%)`).join(', ')
            });

            if (sseManager.getClientCount() > 0) {
                sseManager.broadcastMovementUpdate({
                    type: 'movement_update',
                    movement: formatMovementForSSE(movement_key, updatedMovement)
                });
            }
        } catch (error) {
            deps.logger.warn('Failed to process detection', { movement: movement_key, error: String(error) });
        } finally {
            _inmem_pendingUpdates.delete(parseInt(movement_key));
            
            // Track frames received and ML timing for the current processing movement
            if (_inmem_currentProcessingMovement && 
                _inmem_currentProcessingMovement.movement_key === movement_key) {
                _inmem_currentProcessingMovement.framesReceivedFromML++;
                
                // Track ML processing time stats
                if (processingTimeMs !== null) {
                    _inmem_currentProcessingMovement.mlTotalProcessingTimeMs += processingTimeMs;
                    if (processingTimeMs > _inmem_currentProcessingMovement.mlMaxProcessingTimeMs) {
                        _inmem_currentProcessingMovement.mlMaxProcessingTimeMs = processingTimeMs;
                    }
                }
                
                deps.logger.debug('ML frame received, checking completion', {
                    movement_key,
                    ffmpegExited: _inmem_currentProcessingMovement.ffmpegExited,
                    framesSent: _inmem_currentProcessingMovement.framesSentToML,
                    framesReceived: _inmem_currentProcessingMovement.framesReceivedFromML
                });
                
                // Check if all frames are processed and ffmpeg has exited
                checkAndFinalizeMovement();
            }
        }
    } catch (error) {
        deps.logger.debug('Non-JSON line or parse error', { line, error: String(error) });
    }
}

/**
 * Check if movement processing is complete (ffmpeg exited + all ML results received)
 * If so, trigger the completion callback
 */
function checkAndFinalizeMovement(): void {
    if (!_inmem_currentProcessingMovement) return;
    
    const { ffmpegExited, framesSentToML, framesReceivedFromML, onAllFramesProcessed, movement_key } = _inmem_currentProcessingMovement;
    
    if (ffmpegExited && framesSentToML === framesReceivedFromML) {
        deps.logger.info('All ML frames processed, finalizing movement', {
            movement_key,
            framesSent: framesSentToML,
            framesReceived: framesReceivedFromML
        });
        
        if (onAllFramesProcessed) {
            onAllFramesProcessed();
        }
    }
}

// ============================================================================
// Main Control Loop
// ============================================================================

/**
 * Run the main control loop (called every second)
 */
export async function runControlLoop(): Promise<void> {
    // Manage ML detection process lifecycle
    await controllerDetector();

    const cameraCache = deps.getCameraCache();
    const cameraKeys = Object.keys(cameraCache);

    if (cameraKeys.length === 0) {
        // Only log once per minute
        if (!(global as any).lastNoCameraLog || Date.now() - (global as any).lastNoCameraLog > 60000) {
            deps.logger.warn('No cameras configured');
            (global as any).lastNoCameraLog = Date.now();
        }
        return;
    }

    for (const cKey of cameraKeys) {
        const { cameraEntry, ffmpeg_task } = cameraCache[cKey];

        if (!cameraEntry.delete) {
            // Run controllerFFmpeg
            const task = await controllerFFmpeg(cKey, cameraEntry, ffmpeg_task);
            deps.setCameraCache(cKey, { ...cameraCache[cKey], ffmpeg_task: task });

            // Run controllerFFmpegConfirmation if task is running
            if (task && task.exitCode === null) {
                const confirmation = await controllerFFmpegConfirmation(cKey, cameraEntry, task);
                if (confirmation.shouldRestart) {
                    // Will be restarted on next controllerFFmpeg call
                    deps.setCameraCache(cKey, { ...deps.getCameraCache()[cKey], ffmpeg_task: undefined });
                }
            }

            // Process movement detection
            if (cameraEntry.enable_movement && deps.getCameraCache()[cKey].ffmpeg_task?.exitCode === null) {
                const now = Date.now();
                const streamStartedAt = deps.getCameraCache()[cKey].streamStartedAt || 0;

                // Entry criteria: stream must be confirmed healthy
                if (streamStartedAt === 0) {
                    deps.logger.debug('Waiting for stream to be confirmed healthy', { camera: cameraEntry.name });
                    continue;
                }

                // Entry criteria: startup delay must have passed (use ?? to allow 0)
                const startupDelay = (cameraEntry.secMovementStartupDelay ?? 10) * 1000;
                const delayCheck = checkStartupDelayPassed(streamStartedAt, startupDelay);
                if (!delayCheck.canRun) {
                    const logKey = `lastStartupDelayLog_${cKey}`;
                    if (!(global as any)[logKey] || now - (global as any)[logKey] > 10000) {
                        deps.logger.info('Movement detection startup delay', {
                            camera: cameraEntry.name,
                            reason: delayCheck.reason
                        });
                        (global as any)[logKey] = now;
                    }
                    continue;
                }

                // Entry criteria: poll interval must have elapsed
                const lastCheck = deps.getCameraCache()[cKey].lastMovementCheck || 0;
                const pollInterval = cameraEntry.mSPollFrequency || 1000;
                const intervalCheck = checkIntervalElapsed(lastCheck, pollInterval);

                if (intervalCheck.canRun) {
                    deps.setCameraCache(cKey, { ...deps.getCameraCache()[cKey], lastMovementCheck: now });
                    await detectCameraMovement(cKey);
                }
            }
        }
    }

    // Process pending movements (one at a time, across all cameras)
    await triggerProcessMovement();

    // SSE keep-alive (every 30 seconds)
    sseKeepAlive();
}

/**
 * Run disk cleanup loop (called every minute)
 */
export async function runDiskCleanupLoop(): Promise<void> {
    await controllerClearDownDisk();
}
