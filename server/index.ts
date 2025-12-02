const
    Koa = require('koa'),
    send = require('koa-send')

import fs from 'fs/promises'
import { createReadStream } from 'fs'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Level } from 'level'
import { catalogVideo, diskCheck, DiskCheckReturn } from './diskcheck.js'
import { logger } from './logger.js'
import { 
    spawnProcess, 
    runProcess,
    createFFmpegFrameProcessor, 
    createMLResultProcessor,
    verifyStreamStartup,
    isStreamCurrent,
    setLogger,
    setDependencies,
    getAllProcesses
} from './process-utils.js'
import { sseManager, formatMovementForSSE, setLogger as setSSELogger } from './sse-manager.js'

// Initialize utilities with logger
setLogger(logger);
setSSELogger(logger);


interface Settings {
    disk_base_dir: string;
    disk_cleanup_interval: number;
    disk_cleanup_capacity: number;
    detection_enable: boolean;
    detection_model: string;
    detection_target_hw: string;
    detection_frames_path: string;
    detection_tag_filters: TagFilter[];
}

interface TagFilter {
    tag: string;
    minProbability: number;
}
interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number | null;
    lhs_seg_duration_seq?: number;
    seconds: number;
    pollCount: number;
    consecutivePollsWithoutMovement: number;
    detection_status?: string;  // 'starting', 'extracting', 'analyzing', or undefined when complete
    detection_output?: DetectionOutput;
    
    // Processing state fields
    processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
    processing_started_at?: number;
    processing_completed_at?: number;
    processing_error?: string;
    processing_attempts?: number;
    endSegment?: number | null;  // Final segment when movement ended
    
    // Additional timestamps and keys for new detection logic
    created?: number;      // When movement record was created
    start?: number;        // When movement actually started
    stop?: number;         // When movement actually stopped
    updated?: number;      // Last update timestamp
    movement_key?: string; // Alternative key format for new detection logic
    camera_key?: string;   // Alternative camera key format
}

interface MovementToClient {
    key: number;
    movement: {
        cameraKey: string;
        startDate: number;
        startSegment: number;
        seconds: number;
        detection_status?: string;
        processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
        detection_output?: DetectionOutput;
    };
    startDate_en_GB: string;
}

interface DetectionOutput {
    tags: MLTag[];
}

interface MLTag {
    tag: string;
    maxProbability: number;
    count: number;
    maxProbabilityImage?: string;
}

interface CameraEntry {
    delete: boolean;
    name: string;
    folder: string;
    disk: string;
    ip?: string;
    passwd?: string;
    enable_streaming: boolean;
    enable_movement: boolean;
    pollsWithoutMovement: number;
    secMaxSingleMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
}

interface MovementStatus {
    control: ExecuteControl;
    status?: string;
    current_key?: number;
}

interface MovementDetectionStatus {
    control: ExecuteControl;
    status?: string;
    current_movement_key?: number;
}

interface ProcessingCursor {
    cameraKey: string;
    last_processed_movement_key: number;
    last_check_at: number;
    is_processing: boolean;
}

interface ExecuteControl {
    fn_not_finished : boolean;
    fail: boolean;
    check_after?: number;
}

interface CameraEntryClient extends CameraEntry {
    key: string
   /* ffmpeg_process?: ProcessInfo;*/
    movementStatus?: MovementStatus;
}

interface CameraCacheEntry {
    cameraEntry: CameraEntry;
    ffmpeg_task?: ChildProcessWithoutNullStreams;  // Streaming task only
    movementDetectionStatus?: MovementDetectionStatus;  // Renamed from movementStatus
    lastMovementCheck?: number;
}

interface CameraCache { 
    [key: string]: CameraCacheEntry;
}
var cameraCache: CameraCache = {}

// Processing controller intervals (one per camera)
const processingIntervals: Map<string, NodeJS.Timeout> = new Map();

// Track ffmpeg processes for each movement (key: movement_key, value: process)
const movementFFmpegProcesses: Map<number, ChildProcessWithoutNullStreams> = new Map();

// Global ML detection process
var mlDetectionProcess: ChildProcessWithoutNullStreams | null = null;

interface SettingsCache {
    settings: Settings;
    status: SettingsStatus;
}

interface SettingsStatus { 
    nextCheckInMinutes: number;
    lastChecked?: Date;
    fail: boolean;
    error?: string;
}

var settingsCache: SettingsCache 


import { ChildProcessWithoutNullStreams } from 'child_process'
import { clearScreenDown } from 'readline'

const db = new Level(process.env['DBPATH'] || './mydb',  { valueEncoding : 'json' })
const cameradb = db.sublevel<string, CameraEntry>('cameras', { valueEncoding : 'json' })
const movementdb = db.sublevel<string, MovementEntry>('movements', { valueEncoding : 'json' })
const settingsdb = db.sublevel<string, Settings>('settings', { valueEncoding : 'json' })
const cursordb = db.sublevel<string, ProcessingCursor>('processing_cursors', { valueEncoding : 'json' })

// Epoch offset for movement keys (Sept 13, 2020)
const MOVEMENT_KEY_EPOCH = 1600000000;

// Helper functions for movement key encoding (Level v10 string keys with lexicographic ordering)
const encodeMovementKey = (n: number): string => n.toString().padStart(12, '0');
const decodeMovementKey = (s: string): number => parseInt(s, 10);

// Track if shutdown is in progress
let isShuttingDown = false;

// Gracefully stop all spawned processes
async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        logger.warn('Shutdown already in progress');
        return;
    }
    
    isShuttingDown = true;
    logger.info('Graceful shutdown initiated', { signal });
    
    // Stop processing controllers
    for (const cameraKey of processingIntervals.keys()) {
        const interval = processingIntervals.get(cameraKey);
        if (interval) {
            clearInterval(interval);
            processingIntervals.delete(cameraKey);
        }
    }
    logger.info('Processing controllers stopped');
    
    const shutdownPromises: Promise<void>[] = [];
    
    // Stop all movement extraction ffmpeg processes
    for (const [movement_key, ffmpeg] of movementFFmpegProcesses.entries()) {
        if (ffmpeg && ffmpeg.exitCode === null) {
            logger.info('Stopping movement ffmpeg process', { movement: movement_key, pid: ffmpeg.pid });
            
            const promise = new Promise<void>((resolve) => {
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
                    resolve();
                }, 5000);
                
                ffmpeg.once('close', () => {
                    clearTimeout(timeout);
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
    logger.info('Movement ffmpeg processes stopped', { count: movementFFmpegProcesses.size });
    
    // Stop all camera streaming ffmpeg processes
    for (const cameraKey of Object.keys(cameraCache)) {
        const { ffmpeg_task, cameraEntry } = cameraCache[cameraKey];
        
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
    if (mlDetectionProcess && mlDetectionProcess.exitCode === null) {
        logger.info('Stopping ML detection process', { pid: mlDetectionProcess.pid });
        
        const promise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn('ML detection process did not terminate in time - forcing', { 
                    pid: mlDetectionProcess.pid 
                });
                try {
                    mlDetectionProcess.kill('SIGKILL');
                } catch (e) {
                    logger.error('Failed to force kill ML process', { error: String(e) });
                }
                resolve();
            }, 5000);
            
            mlDetectionProcess.once('close', () => {
                clearTimeout(timeout);
                logger.info('ML detection process terminated');
                resolve();
            });
            
            try {
                mlDetectionProcess.kill();
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

const re = new RegExp(`stream([\\d]+).ts`, 'g');

// Track when frames are sent to ML for timing
const mlFrameSentTimes: Map<string, number> = new Map();

// Function to send image path to ML detection process
function sendImageToMLDetection(imagePath: string, movement_key: number): void {
    if (mlDetectionProcess && mlDetectionProcess.stdin && !mlDetectionProcess.killed) {
        try {
            const imageName = imagePath.split('/').pop() || imagePath;
            mlFrameSentTimes.set(imageName, Date.now());
            mlDetectionProcess.stdin.write(`${imagePath}\n`);
            logger.info('Frame sent to ML detector', { frame: imageName, movement: movement_key, path: imagePath });
        } catch (error) {
            logger.warn('Failed to send image to ML detection', { error: String(error) });
        }
    } else {
        logger.warn('ML detection process not available', {
            processExists: mlDetectionProcess !== null,
            stdinExists: mlDetectionProcess?.stdin !== undefined,
            processKilled: mlDetectionProcess?.killed
        });
    }
}

// Track pending updates per movement to avoid concurrent DB writes
var pendingUpdates: Set<number> = new Set();

// Function to parse detection output and update database directly
async function processDetectionResult(line: string): Promise<void> {
    try {
        // Parse JSON format: {"image": "/path/image.jpg", "detections": [{"object": "person", "box": [x1,y1,x2,y2], "probability": 0.85}, ...]}
        const result = JSON.parse(line);
        
        if (!result.image || !result.detections) {
            logger.warn('Invalid detection result format', { line });
            return;
        }
        
        const imagePath = result.image;
        
        // Extract movement_key from filename pattern: mov{movement_key}_0001.jpg
        const imageName = imagePath.split('/').pop() || imagePath;
        const movementKeyMatch = imageName.match(/^mov(\d+)_/);
        if (!movementKeyMatch) {
            logger.warn('Detection received for image with invalid filename format', { image: imageName });
            return;
        }
        
        const movement_key = parseInt(movementKeyMatch[1]);
        
        // Calculate processing time
        const sentTime = mlFrameSentTimes.get(imageName);
        const processingTimeMs = sentTime ? Date.now() - sentTime : null;
        if (sentTime) {
            mlFrameSentTimes.delete(imageName); // Clean up
        }
        
        // Skip if update already in progress for this movement
        if (pendingUpdates.has(movement_key)) {
            logger.debug('Detection update already pending', { movement: movement_key, frame: imageName });
            // Store for next batch
            setTimeout(() => processDetectionResult(line), 50);
            return;
        }
        
        pendingUpdates.add(movement_key);
        
        try {
            // Read current movement state from database
            const movement: MovementEntry = await movementdb.get(encodeMovementKey(movement_key));
            if (!movement) throw new Error(`Movement ${movement_key} not found in database`);
            
            // Get existing tags or initialize empty
            const existingTags = movement.detection_output?.tags || [];
            
            // Convert existing tags to a map for easy lookup
            const tagsMap: { [key: string]: MLTag } = {};
            existingTags.forEach(tag => {
                tagsMap[tag.tag] = tag;
            });
            
            // Log all detections in one line
            if (result.detections && result.detections.length > 0) {
                logger.info('Detection received from ML', { 
                    frame: imageName, 
                    movement: movement_key,
                    processingTime: processingTimeMs ? `${processingTimeMs}ms` : 'unknown',
                    objects: result.detections.map(d => `${d.object}(${(d.probability * 100).toFixed(1)}%)`).join(', '),
                    existingTags: existingTags.length
                });
            }
            
            logger.debug('Processing detections for movement', {
                movement: movement_key,
                frame: imageName,
                detectionCount: result.detections.length,
                existingTagsCount: existingTags.length
            });
            
            // Process all detections for this image
            for (const detection of result.detections) {
                const objectType = detection.object;
                const probability = detection.probability;
                
                // Update or add tag
                const existing = tagsMap[objectType];
                if (!existing || probability > existing.maxProbability) {
                    tagsMap[objectType] = {
                        tag: objectType,
                        maxProbability: Math.round(probability * 100) / 100,  // Round to 2 decimal places
                        count: existing ? existing.count + 1 : 1,
                        maxProbabilityImage: imageName
                    };
                } else {
                    existing.count++;
                }
            }
            
            // Convert map back to sorted array
            const updatedTags: MLTag[] = Object.values(tagsMap)
                .sort((a, b) => b.maxProbability - a.maxProbability);
            
            // Write immediately to database
            const updatedMovement = {
                ...movement,
                detection_status: undefined,  // Clear status once we have results to show
                detection_output: {
                    tags: updatedTags
                }
            };
            
            await movementdb.put(encodeMovementKey(movement_key), updatedMovement);
            
            logger.info('Movement updated with ML results', {
                movement: movement_key,
                tagCount: updatedTags.length,
                tags: updatedTags.map(t => `${t.tag}(${(t.maxProbability*100).toFixed(1)}%)`).join(', ')
            });
            
            // Broadcast ML update via SSE
            if (sseManager.getClientCount() > 0) {
                sseManager.broadcastMovementUpdate({
                    type: 'movement_update',
                    movement: formatMovementForSSE(movement_key, updatedMovement)
                });
            }
            
            logger.debug('ML results updated in database', { 
                movement: movement_key, 
                objectTypes: updatedTags.length,
                detections: updatedTags.map(t => ({ 
                    tag: t.tag, 
                    probability: `${(t.maxProbability*100).toFixed(1)}%`, 
                    count: t.count 
                }))
            });
        } catch (error) {
            logger.warn('Failed to process detection', { movement: movement_key, error: String(error) });
        } finally {
            pendingUpdates.delete(movement_key);
        }
    } catch (error) {
        logger.debug('Non-JSON line or parse error', { line, error: String(error) });
    }
}

// Function to finalize detection results when movement ends
async function flushDetectionsToDatabase(movement_key: number): Promise<void> {
    try {
        const movement: MovementEntry = await movementdb.get(encodeMovementKey(movement_key));
        if (!movement) throw new Error(`Movement ${movement_key} not found in database`);
        
        // Mark ML processing as complete (results already in database from processDetectionResult)
        await movementdb.put(encodeMovementKey(movement_key), {
            ...movement,
            detection_status: undefined
        });
        
        const tags = movement.detection_output?.tags || [];
        logger.info('ML processing complete', { 
            movement: movement_key, 
            objectTypes: tags.length,
            detections: tags.map(t => ({ 
                tag: t.tag, 
                probability: `${(t.maxProbability*100).toFixed(1)}%`, 
                count: t.count, 
                image: t.maxProbabilityImage 
            }))
        });
    } catch (error) {
        logger.warn('Failed to finalize detections', { movement: movement_key, error: String(error) });
    }
}

// Fast polling function - only detects and records movements, doesn't process frames
async function detectCameraMovement(cameraKey: string): Promise<void> {
    const { movementDetectionStatus, cameraEntry } = cameraCache[cameraKey];

    // Circuit breaker
    const control = { fn_not_finished: false, fail: false, check_after: 0 };
    const { fn_not_finished, fail, check_after } = movementDetectionStatus?.control || control;
    
    if (fn_not_finished || (fail && (!check_after || check_after > Date.now()))) {
        logger.debug('detectCameraMovement skipped - already in progress or in failure backoff', { 
            camera: cameraEntry.name, 
            cameraKey,
            fn_not_finished,
            fail,
            check_after: check_after ? new Date(check_after).toISOString() : null
        });
        return;
    }
    
    // Set flag to prevent concurrent execution
    cameraCache[cameraKey] = {
        ...cameraCache[cameraKey],
        movementDetectionStatus: {
            ...movementDetectionStatus,
            control: { fail, check_after, fn_not_finished: true }
        }
    };
    
    logger.debug('detectCameraMovement started', { 
        camera: cameraEntry.name, 
        cameraKey,
        current_movement_key: movementDetectionStatus?.current_movement_key
    });

    const { ip, passwd } = cameraEntry;
    
    try {
        const { current_movement_key } = movementDetectionStatus || { current_movement_key: undefined };
        
        const apiUrl = `http://${ip}/api.cgi?cmd=GetMdState&user=admin&password=${passwd}`;
        
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
        
        // Parse the JSON response (camera returns JSON with text/html content type)
        const body = JSON.parse(body_json);
        const movementState = body[0]?.value?.state;
        
        logger.info('Movement detection API result', {
            camera: cameraEntry.name,
            state: movementState === 1 ? 'MOVEMENT' : 'NO_MOVEMENT',
            rawState: movementState
        });
        
        if (body[0]?.error) {
            throw new Error(`Camera API error: ${JSON.stringify(body[0].error)}`);
        }
        
        const hasMovement = movementState === 1;
        
        // Only log poll when there's something interesting (movement or tracking existing movement)
        if (hasMovement || current_movement_key !== undefined) {
            logger.debug('Movement detection poll', {
                camera: cameraEntry.name,
                hasMovement,
                current_movement_key
            });
        }
        
        // Handle movement lifecycle
        if (hasMovement && !current_movement_key) {
            // New movement detected - create minimal database entry
            const startDate = Date.now();
            const movement_key = startDate;
            
            const movementEntry: MovementEntry = {
                cameraKey,
                startDate,
                startSegment: null as any,  // Will be set during processing
                seconds: 0,
                pollCount: 0,
                consecutivePollsWithoutMovement: 0,
                processing_state: 'pending'
            };
            
            await movementdb.put(encodeMovementKey(movement_key), movementEntry);
            
            logger.info('New movement detected', {
                camera: cameraEntry.name,
                movement_key
            });
            
            // Update cache
            cameraCache[cameraKey] = {
                ...cameraCache[cameraKey],
                movementDetectionStatus: {
                    current_movement_key: movement_key,
                    status: 'Movement detected',
                    control: { ...control, fn_not_finished: false }
                }
            };
            
            // Notify SSE clients
            sseManager.broadcastMovementUpdate({
                type: 'movement_new',
                movement: formatMovementForSSE(movement_key, movementEntry)
            });
            
            // Immediately trigger processing instead of waiting for next 5s interval
            setImmediate(() => processCameraMovement(cameraKey));
            
        } else if (!hasMovement && current_movement_key !== undefined) {
            // Movement ended - mark in database and check if should terminate
            logger.debug('Movement ended - checking termination conditions', {
                camera: cameraEntry.name,
                movement_key: current_movement_key
            });
            
            const existing = await movementdb.get(encodeMovementKey(current_movement_key));
            const now = Date.now();
            const elapsedSeconds = Math.floor((now - existing.startDate) / 1000);
            const consecutivePolls = (existing.consecutivePollsWithoutMovement || 0) + 1;
            
            // Check if movement should end
            const pollsWithoutMovement = cameraEntry.pollsWithoutMovement;
            const maxDuration = cameraEntry.secMaxSingleMovement || 600;
            const shouldEndMovement = 
                pollsWithoutMovement === 0 || // Immediate stop
                consecutivePolls >= pollsWithoutMovement || // Exceeded poll threshold
                elapsedSeconds > maxDuration; // Exceeded max duration
            
            logger.debug('Movement termination check', {
                camera: cameraEntry.name,
                movement_key: current_movement_key,
                elapsedSeconds,
                consecutivePolls,
                pollsWithoutMovement,
                maxDuration,
                shouldEndMovement
            });
            
            if (shouldEndMovement) {
                // Terminate ffmpeg process if still running
                const ffmpegProcess = movementFFmpegProcesses.get(current_movement_key);
                if (ffmpegProcess && ffmpegProcess.exitCode === null) {
                    const reason = elapsedSeconds > maxDuration
                        ? `max duration (${maxDuration}s) exceeded`
                        : (pollsWithoutMovement === 0 
                            ? 'camera reports no movement (immediate stop)'
                            : `${consecutivePolls} polls without movement (threshold: ${pollsWithoutMovement})`);
                    
                    logger.info('Terminating movement ffmpeg', {
                        camera: cameraEntry.name,
                        movement_key: current_movement_key,
                        reason,
                        pid: ffmpegProcess.pid
                    });
                    
                    ffmpegProcess.kill();
                }
                
                const updated: MovementEntry = {
                    ...existing,
                    seconds: elapsedSeconds,
                    consecutivePollsWithoutMovement: consecutivePolls
                };
                
                await movementdb.put(encodeMovementKey(current_movement_key), updated);
                
                logger.info('Movement ended', {
                    camera: cameraEntry.name,
                    movement_key: current_movement_key,
                    duration: elapsedSeconds,
                    consecutivePolls,
                    reason: elapsedSeconds > maxDuration ? 'max_duration' : 'no_movement'
                });
                
                // Update cache
                cameraCache[cameraKey] = {
                    ...cameraCache[cameraKey],
                    movementDetectionStatus: {
                        current_movement_key: undefined,
                        status: 'No movement',
                        control: { ...control, fn_not_finished: false }
                    }
                };
                
                // Notify SSE clients
                sseManager.broadcastMovementUpdate({
                    type: 'movement_complete',
                    movement: formatMovementForSSE(current_movement_key, updated)
                });
            } else {
                // Still within grace period - update polls count
                const updated: MovementEntry = {
                    ...existing,
                    seconds: elapsedSeconds,
                    consecutivePollsWithoutMovement: consecutivePolls
                };
                
                await movementdb.put(encodeMovementKey(current_movement_key), updated);
                
                logger.debug('Movement grace period', {
                    camera: cameraEntry.name,
                    movement_key: current_movement_key,
                    consecutivePolls,
                    threshold: pollsWithoutMovement
                });
            }
            
        } else if (hasMovement && current_movement_key !== undefined) {
            // Movement continuation - update duration and check max duration
            const existing = await movementdb.get(encodeMovementKey(current_movement_key));
            const now = Date.now();
            const elapsedSeconds = Math.floor((now - existing.startDate) / 1000);
            const maxDuration = cameraEntry.secMaxSingleMovement || 600;
            
            if (elapsedSeconds > maxDuration) {
                // Max duration exceeded - terminate
                const ffmpegProcess = movementFFmpegProcesses.get(current_movement_key);
                if (ffmpegProcess && ffmpegProcess.exitCode === null) {
                    logger.info('Terminating movement ffmpeg', {
                        camera: cameraEntry.name,
                        movement_key: current_movement_key,
                        reason: `max duration (${maxDuration}s) exceeded`,
                        pid: ffmpegProcess.pid
                    });
                    ffmpegProcess.kill();
                }
                
                const updated: MovementEntry = {
                    ...existing,
                    seconds: elapsedSeconds,
                    consecutivePollsWithoutMovement: 0
                };
                
                await movementdb.put(encodeMovementKey(current_movement_key), updated);
                
                logger.info('Movement ended - max duration', {
                    camera: cameraEntry.name,
                    movement_key: current_movement_key,
                    duration: elapsedSeconds
                });
                
                // Clear current movement
                cameraCache[cameraKey] = {
                    ...cameraCache[cameraKey],
                    movementDetectionStatus: {
                        current_movement_key: undefined,
                        status: 'No movement',
                        control: { ...control, fn_not_finished: false }
                    }
                };
                
                // Notify SSE clients
                sseManager.broadcastMovementUpdate({
                    type: 'movement_complete',
                    movement: formatMovementForSSE(current_movement_key, updated)
                });
            } else {
                // Normal continuation - reset polls counter
                const updated: MovementEntry = {
                    ...existing,
                    seconds: elapsedSeconds,
                    pollCount: (existing.pollCount || 0) + 1,
                    consecutivePollsWithoutMovement: 0  // Reset on movement
                };
                
                await movementdb.put(encodeMovementKey(current_movement_key), updated);
                
                logger.debug('Movement continuation', {
                    camera: cameraEntry.name,
                    movement_key: current_movement_key,
                    duration: elapsedSeconds
                });
                
                cameraCache[cameraKey] = {
                    ...cameraCache[cameraKey],
                    movementDetectionStatus: {
                        ...movementDetectionStatus,
                        status: 'Movement continuing',
                        control: { ...control, fn_not_finished: false }
                    }
                };
            }
        } else {
            // No movement and no current movement - only log on state change
            if (movementDetectionStatus?.status !== 'No movement') {
                cameraCache[cameraKey] = {
                    ...cameraCache[cameraKey],
                    movementDetectionStatus: {
                        ...movementDetectionStatus,
                        status: 'No movement',
                        control: { ...control, fn_not_finished: false }
                    }
                };
            } else {
                // Just reset flag, don't update cache
                if (movementDetectionStatus) {
                    movementDetectionStatus.control.fn_not_finished = false;
                }
            }
        }
        
    } catch (error) {
        const filtersensitive = String(error).replace(new RegExp(passwd, 'g'), '****');
        logger.error('detectCameraMovement failed', {
            camera: cameraEntry.name,
            error: filtersensitive
        });
        
        cameraCache[cameraKey] = {
            ...cameraCache[cameraKey],
            movementDetectionStatus: {
                ...movementDetectionStatus,
                status: `Detection failed: ${filtersensitive}`,
                control: {
                    fail: true,
                    check_after: Date.now() + 10000, // 10 seconds
                    fn_not_finished: false
                }
            }
        };
    } finally {
        // Always reset fn_not_finished flag, even if error occurred mid-function
        if (cameraCache[cameraKey]?.movementDetectionStatus) {
            cameraCache[cameraKey].movementDetectionStatus.control.fn_not_finished = false;
            
            // Only log completion for interesting events (not idle polling)
            if (movementDetectionStatus?.current_movement_key !== undefined || 
                movementDetectionStatus?.status !== 'No movement') {
                logger.debug('detectCameraMovement completed - flag reset', {
                    camera: cameraEntry?.name,
                    cameraKey
                });
            }
        }
    }
}

// Helper: Find the next unprocessed movement for a camera
async function findNextUnprocessedMovement(cameraKey: string): Promise<{ key: number; movement: MovementEntry } | null> {
    try {
        // Get cursor to know where we left off
        let cursor = await cursordb.get(cameraKey);
        
        // Level v10 returns undefined for missing keys instead of throwing
        if (!cursor) {
            cursor = {
                cameraKey,
                last_processed_movement_key: 0,
                last_check_at: Date.now(),
                is_processing: false
            };
            await cursordb.put(cameraKey, cursor);
        }
        
        // Find movements for this camera that are pending or failed (with retries left)
        const movements: Array<{ key: number; movement: MovementEntry }> = [];
        
        for await (const [key, movement] of movementdb.iterator()) {
            const movement_key = parseInt(key);
            
            // Only movements for this camera
            if (movement.cameraKey !== cameraKey) continue;
            
            // Only movements after the cursor
            if (movement_key <= cursor.last_processed_movement_key) continue;
            
            // Check if pending or failed with retries left
            const isPending = !movement.processing_state || movement.processing_state === 'pending';
            const isFailed = movement.processing_state === 'failed' && (movement.processing_attempts || 0) < 3;
            
            if (isPending || isFailed) {
                movements.push({ key: movement_key, movement });
            }
        }
        
        // Return the oldest one (lowest key)
        if (movements.length > 0) {
            movements.sort((a, b) => a.key - b.key);
            return movements[0];
        }
        
        return null;
    } catch (error) {
        logger.error('findNextUnprocessedMovement failed', { cameraKey, error: String(error) });
        return null;
    }
}

// Slow processing function - processes one movement at a time per camera
async function processCameraMovement(cameraKey: string): Promise<void> {
    const { cameraEntry } = cameraCache[cameraKey];
    
    if (!cameraEntry) {
        logger.warn('processCameraMovement - camera not found', { cameraKey });
        return;
    }
    
    try {
        // Check if already processing
        let cursor = await cursordb.get(cameraKey);
        
        // Level v10 returns undefined for missing keys
        if (!cursor) {
            cursor = {
                cameraKey,
                last_processed_movement_key: 0,
                last_check_at: Date.now(),
                is_processing: false
            };
        }
        
        if (cursor.is_processing) {
            logger.debug('processCameraMovement - already processing', { 
                camera: cameraEntry.name, 
                cameraKey 
            });
            return;
        }
        
        // Find next movement to process
        const next = await findNextUnprocessedMovement(cameraKey);
        
        if (!next) {
            logger.debug('processCameraMovement - no pending movements', { 
                camera: cameraEntry.name, 
                cameraKey 
            });
            
            // Update cursor check time
            await cursordb.put(cameraKey, {
                ...cursor,
                last_check_at: Date.now()
            });
            return;
        }
        
        const { key: movement_key, movement } = next;
        
        logger.info('Processing movement', {
            camera: cameraEntry.name,
            movement_key,
            attempt: (movement.processing_attempts || 0) + 1
        });
        
        // Mark as processing
        await cursordb.put(cameraKey, {
            ...cursor,
            is_processing: true,
            last_check_at: Date.now()
        });
        
        const now = Date.now();
        await movementdb.put(encodeMovementKey(movement_key), {
            ...movement,
            processing_state: 'processing',
            processing_started_at: now,
            processing_attempts: (movement.processing_attempts || 0) + 1
        });
        
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
            
            // Calculate start segment accounting for poll frequency
            const segmentsToLookBack = Math.ceil(cameraEntry.mSPollFrequency / (lhs_seg_duration_seq * 1000));
            startSegment = parseInt(hls_segments[hls_segments.length - 1]) - segmentsToLookBack + 1;
            
            // Update movement with segment info
            await movementdb.put(encodeMovementKey(movement_key), {
                ...movement,
                startSegment,
                lhs_seg_duration_seq,
                processing_state: 'processing',
                processing_started_at: now,
                processing_attempts: (movement.processing_attempts || 0) + 1
            });
        } catch (error) {
            logger.error('Failed to read HLS playlist', {
                camera: cameraEntry.name,
                movement_key,
                error: String(error)
            });
            
            // Mark as failed
            await movementdb.put(encodeMovementKey(movement_key), {
                ...movement,
                processing_state: 'failed',
                processing_error: `Failed to read HLS playlist: ${String(error)}`,
                processing_completed_at: Date.now()
            });
            
            // Reset cursor
            await cursordb.put(cameraKey, {
                ...cursor,
                is_processing: false,
                last_processed_movement_key: movement_key,
                last_check_at: Date.now()
            });
            return;
        }
        
        // Setup frame extraction
        const framesPath = getFramesPath(disk, folder);
        await ensureDir(framesPath);
        
        const ffmpegArgs = [
            '-hide_banner', '-loglevel', 'info',
            '-progress', 'pipe:1',
            '-i', filepath,
            '-vf', 'fps=1,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2',
            `${framesPath}/mov${movement_key}_%04d.jpg`
        ];
        
        logger.info('Starting ffmpeg for frame extraction', {
            camera: cameraEntry.name,
            movement: movement_key,
            framesPath,
            mlEnabled: settingsCache.settings.detection_enable
        });
        
        // Update status
        if (settingsCache.settings.detection_enable) {
            setTimeout(async () => {
                try {
                    const m = await movementdb.get(encodeMovementKey(movement_key));
                    await movementdb.put(encodeMovementKey(movement_key), {
                        ...m,
                        detection_status: 'extracting'
                    });
                    
                    if (sseManager.getClientCount() > 0) {
                        sseManager.broadcastMovementUpdate({
                            type: 'movement_update',
                            movement: formatMovementForSSE(movement_key, { ...m, detection_status: 'extracting' })
                        });
                    }
                } catch (e) {
                    logger.warn('Failed to update status to extracting', { movement: movement_key, error: String(e) });
                }
            }, 100);
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
                logger.error('ffmpeg frame extraction error', {
                    camera: cameraEntry.name,
                    movement: movement_key,
                    error: error.message
                });
            },
            onClose: async (code: number | null, signal: string | null) => {
                const isGraceful = code === 0 || code === 255 || signal === 'SIGTERM' || signal === 'SIGKILL' || isShuttingDown;
                
                logger.info('ffmpeg frame extraction complete', {
                    camera: cameraEntry.name,
                    movement: movement_key,
                    exitCode: code,
                    signal,
                    totalFrames: frameProcessor.getLastFrameNumber(),
                    graceful: isGraceful
                });
                
                // Remove from tracking map
                movementFFmpegProcesses.delete(movement_key);
                
                // Flush ML detections if enabled
                if (settingsCache.settings.detection_enable) {
                    setTimeout(async () => {
                        await flushDetectionsToDatabase(movement_key);
                    }, 3000);
                }
                
                // Mark as completed or failed
                try {
                    const m = await movementdb.get(encodeMovementKey(movement_key));
                    const totalFrames = frameProcessor.getLastFrameNumber();
                    const hasFailed = !isGraceful || totalFrames === 0 || code !== 255;
                    
                    await movementdb.put(encodeMovementKey(movement_key), {
                        ...m,
                        processing_state: hasFailed ? 'failed' as const : 'completed' as const,
                        processing_completed_at: Date.now(),
                        ...(hasFailed && { processing_error: totalFrames === 0 ? 'No frames extracted' : `ffmpeg exited with code ${code}` })
                    });
                    
                    if (hasFailed) {
                        logger.warn('Movement processing failed', {
                            camera: cameraEntry.name,
                            movement_key,
                            totalFrames,
                            exitCode: code,
                            graceful: isGraceful
                        });
                    } else {
                        logger.info('Movement processing completed', {
                            camera: cameraEntry.name,
                            movement_key
                        });
                    }
                } catch (error) {
                    logger.error('Failed to mark movement as completed', {
                        camera: cameraEntry.name,
                        movement_key,
                        error: String(error)
                    });
                }
                
                // Reset cursor to allow next movement to process
                try {
                    const c = await cursordb.get(cameraKey);
                    if (c) {
                        await cursordb.put(cameraKey, {
                            ...c,
                            is_processing: false,
                            last_processed_movement_key: movement_key,
                            last_check_at: Date.now()
                        });
                        logger.debug('Cursor reset after ffmpeg completion - ready for next movement', {
                            camera: cameraEntry.name,
                            movement_key
                        });
                    }
                } catch (error) {
                    logger.error('Failed to reset cursor after completion', {
                        camera: cameraEntry.name,
                        error: String(error)
                    });
                }
            }
        });
        
        // Store ffmpeg process in tracking map for movement termination
        movementFFmpegProcesses.set(movement_key, ffmpeg);
        
    } catch (error) {
        logger.error('processCameraMovement failed', {
            camera: cameraEntry.name,
            error: String(error)
        });
        
        // Reset cursor on error
        try {
            const cursor = await cursordb.get(cameraKey);
            if (cursor) {
                await cursordb.put(cameraKey, {
                    ...cursor,
                    is_processing: false,
                    last_check_at: Date.now()
                });
            }
        } catch (e) {
            logger.error('Failed to reset cursor after error', {
                camera: cameraEntry.name,
                error: String(e)
            });
        }
    }
}

// Controller functions for processing
function startProcessingController(cameraKey: string): void {
    // Stop existing controller if any
    stopProcessingController(cameraKey);
    
    const { cameraEntry } = cameraCache[cameraKey];
    if (!cameraEntry) return;
    
    // Start processing every 5 seconds
    const interval = setInterval(async () => {
        await processCameraMovement(cameraKey);
    }, 5000);
    
    processingIntervals.set(cameraKey, interval);
    
    logger.info('Processing controller started', {
        camera: cameraEntry.name,
        cameraKey,
        intervalMs: 5000
    });
}

function stopProcessingController(cameraKey: string): void {
    const interval = processingIntervals.get(cameraKey);
    if (interval) {
        clearInterval(interval);
        processingIntervals.delete(cameraKey);
        
        const { cameraEntry } = cameraCache[cameraKey];
        logger.info('Processing controller stopped', {
            camera: cameraEntry?.name,
            cameraKey
        });
    }
}

// Reset stale processing locks on startup
async function resetStaleProcessingLocks(): Promise<void> {
    logger.info('Resetting stale processing locks...');
    
    try {
        for await (const [cameraKey, cursor] of cursordb.iterator()) {
            if (cursor.is_processing) {
                logger.warn('Found stale processing lock', {
                    cameraKey,
                    last_check: new Date(cursor.last_check_at).toISOString()
                });
                
                await cursordb.put(cameraKey, {
                    ...cursor,
                    is_processing: false
                });
            }
        }
        
        // Also reset any movements stuck in 'processing' state
        for await (const [key, movement] of movementdb.iterator()) {
            if (movement.processing_state === 'processing') {
                const movement_key = parseInt(key);
                logger.warn('Found movement stuck in processing state', {
                    movement_key,
                    camera: movement.cameraKey,
                    started: movement.processing_started_at ? new Date(movement.processing_started_at).toISOString() : 'unknown'
                });
                
                await movementdb.put(key, {
                    ...movement,
                    processing_state: 'pending',
                    processing_error: 'Reset after server restart'
                });
            }
        }
        
        logger.info('Stale lock reset complete');
    } catch (error) {
        logger.error('Failed to reset stale locks', { error: String(error) });
    }
}

 // OLD FUNCTION - DEPRECATED - Kept for reference only
 // This function has been replaced by detectCameraMovement (fast detection) 
 // and processCameraMovement (slow frame processing)
 /*
async function processMovement(cameraKey: string) : Promise<void> {

    const { movementStatus, cameraEntry } = cameraCache[cameraKey]

    // --------- Circuit breaker
    // circuit breaker, if movement error recorded from API, don't try again, until after check_after!
    const control = { fn_not_finished: false, fail: false, check_after: 0 }
    const { fn_not_finished, fail, check_after } = movementStatus?.control || control
    
    // Check and set the flag atomically - if already running, exit immediately
    if (fn_not_finished  || (fail && ( (!check_after) || check_after > Date.now())) ) {
            logger.debug('processMovement skipped - already in progress or in failure backoff', { camera: cameraEntry.name, cameraKey, fn_not_finished, fail });
            return
    }
    
    // Set flag to prevent concurrent execution
    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, control: { fail, check_after, fn_not_finished : true}}}
    logger.debug('processMovement started', { camera: cameraEntry.name, cameraKey });
    // ---------- end Circuit breaker


    const {ip, passwd, disk, folder, pollsWithoutMovement, secMaxSingleMovement} = cameraEntry
    try {

        const {current_key, current_taskid } = movementStatus || { current_key: null, current_taskid: null }

        const apiUrl = `http://${ip}/api.cgi?cmd=GetMdState&user=admin&password=${passwd}`;
        logger.debug('Checking movement API', { camera: cameraEntry.name, ip, url: apiUrl.replace(passwd, '****') });
        
        const fetchStart = Date.now();
        
        // Simple timeout implementation with Promise.race - includes both fetch and response.text()
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
        const fetchDuration = Date.now() - fetchStart;
        
        // camera content type response is "text/html" even though its json :)
        const body = JSON.parse(body_json)
        const movementState = body[0]?.value?.state;
        
        logger.info('Movement API Poll', { 
            camera: cameraEntry.name, 
            duration: `${fetchDuration}ms`, 
            movementDetected: movementState === 1,
            state: movementState
        });
        
        logger.debug('Movement API Response body received', { 
            camera: cameraEntry.name, 
            bodyLength: body_json.length,
            bodyPreview: body_json.substring(0, 100)
        });
        //console.log(body[0].value)
        if (body[0].error) {
            logger.error('Camera API error', { camera: cameraEntry.name, error: body[0].error });
            cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: `fetch movement error: ${JSON.stringify(body)}`, control: {fail: true, fn_not_finished : false, check_after: Date.now() + (30 * 1000)}}}
        } else if (body[0].value.state === 1) {
            // Got movement (state ===1)
            if (!current_key) {
                // got NEW movement
                logger.info('New movement detected', { camera: cameraEntry.name, type: 'movement_start' })

                // Need to determine the segment that corresponds to the movement
                // Read the current live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${disk}/${folder}/stream.m3u8`
                const hls = (await fs.readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")

                // Account for poll frequency - movement could have started anytime during poll interval
                // Go back enough segments to cover the poll interval, plus 1 for ffmpeg lag
                const segmentsToLookBack = Math.ceil(cameraEntry.mSPollFrequency / (lhs_seg_duration_seq * 1000));

                const startDate = Date.now(),
                      movement_key = startDate,
                      startSegment = parseInt(hls_segments[hls_segments.length - 1]) - segmentsToLookBack + 1

                const framesPath = getFramesPath(disk, folder);
                await ensureDir(framesPath);

                const ffmpegArgs = [
                    '-hide_banner', '-loglevel', 'info',
                    '-progress', 'pipe:1',
                    '-i', filepath,
                    '-vf', 'fps=1,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2',
                    `${framesPath}/mov${movement_key}_%04d.jpg`
                ];

                logger.info('Starting ffmpeg for frame extraction', {
                    camera: cameraEntry.name,
                    movement: movement_key,
                    framesPath,
                    inputFile: filepath,
                    mlEnabled: settingsCache.settings.detection_enable
                });

                // Update status to 'extracting' after a short delay to ensure ffmpeg has started
                setTimeout(async () => {
                    if (settingsCache.settings.detection_enable) {
                        try {
                            const m = await movementdb.get(encodeMovementKey(movement_key));
                            const updatedMovement = {
                                ...m,
                                detection_status: 'extracting'
                            };
                            await movementdb.put(encodeMovementKey(movement_key), updatedMovement);
                            
                            // Broadcast status update via SSE
                            if (sseManager.getClientCount() > 0) {
                                const formattedMovement = formatMovementForSSE(movement_key, updatedMovement);
                                sseManager.broadcastMovementUpdate({
                                    type: 'movement_update',
                                    movement: formattedMovement
                                });
                            }
                        } catch (e) {
                            logger.warn('Failed to update status to extracting', { movement: movement_key, error: String(e) });
                        }
                    }
                }, 100);

                // Create stream processor for ffmpeg output
                const frameProcessor = createFFmpegFrameProcessor(movement_key, framesPath, cameraEntry.name);

                // Spawn ffmpeg with pipeline processors
                var ffmpeg = spawnProcess({
                    name: `ffmpeg-${cameraEntry.name}-mov${movement_key}`,
                    cmd: '/usr/bin/ffmpeg',
                    args: ffmpegArgs,
                    onStdout: frameProcessor.processStdout,
                    onStderr: frameProcessor.processStderr,
                    onError: (error: Error) => {
                        logger.error('ffmpeg frame extraction error', { 
                            camera: cameraEntry.name, 
                            movement: movement_key,
                            error: error.message 
                        });
                    },
                    onClose: async (code: number | null, signal: string | null) => {
                        const isGraceful = code === 0 || code === 255 || signal === 'SIGTERM' || signal === 'SIGKILL' || isShuttingDown;
                        
                        logger.info('ffmpeg frame extraction complete', { 
                            camera: cameraEntry.name, 
                            movement: movement_key, 
                            exitCode: code, 
                            signal,
                            totalFrames: frameProcessor.getLastFrameNumber(),
                            graceful: isGraceful
                        });
                        
                        // Wait for remaining ML detections to complete, then flush
                        if (settingsCache.settings.detection_enable) {
                            logger.debug('Scheduling ML detection flush', {
                                camera: cameraEntry.name,
                                movement: movement_key,
                                delayMs: 3000
                            });
                            setTimeout(async () => {
                                await flushDetectionsToDatabase(movement_key);
                            }, 3000);
                        }
                    }
                });

                const newMovement = {
                    cameraKey,
                    startDate,
                    startSegment,
                    lhs_seg_duration_seq,
                    seconds: 0,
                    pollCount: 1,
                    consecutivePollsWithoutMovement: 0,
                    detection_status: settingsCache.settings.detection_enable ? 'starting' : undefined
                };
                
                await movementdb.put(encodeMovementKey(movement_key), newMovement);
                
                // Broadcast new movement via SSE
                if (sseManager.getClientCount() > 0) {
                    const formattedMovement = formatMovementForSSE(movement_key, newMovement);
                    sseManager.broadcastMovementUpdate({
                        type: 'movement_new',
                        movement: formattedMovement
                    });
                }

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {current_key: movement_key, current_taskid: ffmpeg, status: "New movement detected", control: {...control, fn_not_finished: false}}}

            } else {
                // continuatation of same movment event
                const m: MovementEntry = await movementdb.get(encodeMovementKey(current_key))
                
                // Calculate duration based on poll count × poll frequency
                const updatedPollCount = m.pollCount + 1;
                const durationSeconds = Math.floor((updatedPollCount * cameraEntry.mSPollFrequency) / 1000);

                if (durationSeconds > (secMaxSingleMovement || 600)) {
                    logger.info('Movement ended - max duration', { camera: cameraEntry.name, duration: `${secMaxSingleMovement}s` })
                    if (current_taskid && current_taskid.exitCode === null) {
                        logger.info('Terminating ffmpeg frame extraction', { camera: cameraEntry.name, movement: current_key, reason: 'max duration exceeded', pid: current_taskid.pid });
                        
                        // Wait for ffmpeg to fully terminate
                        await new Promise<void>((resolve) => {
                            const timeout = setTimeout(() => {
                                logger.warn('ffmpeg termination timeout - forcing', { camera: cameraEntry.name, movement: current_key });
                                resolve();
                            }, 5000); // 5 second timeout
                            
                            current_taskid.once('close', () => {
                                clearTimeout(timeout);
                                logger.debug('ffmpeg terminated successfully', { camera: cameraEntry.name, movement: current_key });
                                resolve();
                            });
                            
                            current_taskid.kill();
                        });
                    }
                    
                    // Flush ML detections if enabled
                    if (settingsCache.settings.detection_enable) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finished: false}}}
                    
                } else {
                    logger.debug('Movement continuation', { camera: cameraEntry.name, duration: `${durationSeconds}s` });
                    const updatedMovement = {...m, seconds: durationSeconds, pollCount: updatedPollCount, consecutivePollsWithoutMovement: 0};
                    await movementdb.put(encodeMovementKey(current_key), updatedMovement);
                    
                    // Broadcast update via SSE
                    if (sseManager.getClientCount() > 0) {
                        const formattedMovement = formatMovementForSSE(current_key, updatedMovement);
                        sseManager.broadcastMovementUpdate({
                            type: 'movement_update',
                            movement: formattedMovement
                        });
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "Movement Continuation", control: {...control, fn_not_finished: false}}}
                }

            }
        } else {
            // no movement from camera
            if (current_key) {
                // got current movement
                const m: MovementEntry = await movementdb.get(encodeMovementKey(current_key))
                
                // Increment consecutive polls without movement
                const consecutivePolls = m.consecutivePollsWithoutMovement + 1;
                const elapsedSeconds = Math.floor((Date.now() - m.startDate) / 1000);
                
                // pollsWithoutMovement of 0 means stop immediately when camera reports no movement
                // Otherwise, wait for the specified number of consecutive polls
                const shouldEndMovement = pollsWithoutMovement === 0 || consecutivePolls > pollsWithoutMovement;
                
                if (shouldEndMovement || elapsedSeconds > (secMaxSingleMovement || 600)) {

                    logger.info('Movement complete', { camera: cameraEntry.name, duration: `${elapsedSeconds}s`, pollsWithoutMovement: consecutivePolls, extendSetting: pollsWithoutMovement })
                    if (current_taskid && current_taskid.exitCode === null) {
                        const reason = shouldEndMovement 
                            ? (pollsWithoutMovement === 0 
                                ? 'camera reports no movement (immediate stop)' 
                                : `${consecutivePolls} polls without movement (extended ${pollsWithoutMovement} polls)`)
                            : 'max duration exceeded';
                        logger.info('Terminating ffmpeg frame extraction', { camera: cameraEntry.name, movement: current_key, reason, pid: current_taskid.pid });
                        
                        // Wait for ffmpeg to fully terminate
                        await new Promise<void>((resolve) => {
                            const timeout = setTimeout(() => {
                                logger.warn('ffmpeg termination timeout - forcing', { camera: cameraEntry.name, movement: current_key });
                                resolve();
                            }, 5000); // 5 second timeout
                            
                            current_taskid.once('close', () => {
                                clearTimeout(timeout);
                                logger.debug('ffmpeg terminated successfully', { camera: cameraEntry.name, movement: current_key });
                                resolve();
                            });
                            
                            current_taskid.kill();
                        });
                    }
                    
                    // Flush ML detections if enabled
                    if (settingsCache.settings.detection_enable) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finished: false}}}
                    

                } else {
                    // still same movement, update elapsed time and consecutive polls without movement
                    await movementdb.put(encodeMovementKey(current_key), {...m, seconds: elapsedSeconds, consecutivePollsWithoutMovement: consecutivePolls})
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "Movement Continuation (withoutmovement)", control: {...control, fn_not_finished: false}}}
                }
            } else {
                // no current movement, camera is not reporting movement
                cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "No current movement", control: {...control, fn_not_finished: false}}}
            }
        }
    } catch (e) {
        const filtersensitive = e?.message ? e.message.replaceAll(passwd, "****").replaceAll(ip, "****") : e
        logger.error('Movement detection failed', { 
            camera: cameraEntry?.name, 
            error: filtersensitive,
            willRetryAfter: '30s'
        });
        cameraCache[cameraKey] = { ...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: `processMovement failed error: ${filtersensitive}`, control: {
            fail: true, 
            fn_not_finished : false,
            check_after: Date.now() + (30 * 1000)
        }}}
    }
}
*/

// Manage ML detection process lifecycle
async function processControllerDetector(): Promise<void> {
    const { settings } = settingsCache;
    const enabled = settings.detection_enable && !!settings.detection_model;
    
    // If disabled, stop any running process
    if (!enabled) {
        if (mlDetectionProcess && mlDetectionProcess.exitCode === null) {
            logger.info('ML detection disabled - stopping process', { pid: mlDetectionProcess.pid });
            mlDetectionProcess.kill();
            mlDetectionProcess = null;
        }
        return;
    }
    
    // If enabled and not running, start it
    if (!mlDetectionProcess || mlDetectionProcess.exitCode !== null) {
        try {
            const baseDir = process.env['PWD'];
            const aiDir = `${baseDir}/ai`;
            const cmdArgs = ['-u', '-m', 'detector.detect', '--model_path', settings.detection_model];
            
            if (settings.detection_target_hw) {
                cmdArgs.push('--target', settings.detection_target_hw);
            }
            
            const mlProcessor = createMLResultProcessor(processDetectionResult);
            
            mlDetectionProcess = spawnProcess({
                name: 'ML-Detection',
                cmd: 'python3',
                args: cmdArgs,
                cwd: aiDir,
                onStdout: mlProcessor.processStdout,
                onStderr: mlProcessor.processStderr,
                onError: (error: Error) => {
                    logger.error('ML detection process error', { error: error.message });
                },
                onClose: (code: number | null, signal: string | null) => {
                    const isGraceful = code === 0 || code === null || isShuttingDown;
                    if (!isGraceful) {
                        logger.error('ML detection process exited unexpectedly', { 
                            code, 
                            signal,
                            willRestart: 'on next interval' 
                        });
                    } else {
                        logger.info('ML detection process closed gracefully', { code, signal });
                    }
                    mlDetectionProcess = null;
                }
            });
            
            logger.info('ML detection pipeline initialized', { 
                pid: mlDetectionProcess.pid,
                model: settings.detection_model,
                target: settings.detection_target_hw || 'default'
            });
        } catch (error) {
            logger.error('Failed to start ML detection process', { error: String(error) });
            mlDetectionProcess = null;
        }
    }
}

// run every second to start new cameras, and ensure steaming is working for running cameras
var processControllerFFmpeg_inprogress: { [key: string]: { inprogress: boolean; checkFrom: number } } = {};

async function processControllerFFmpeg(
    cameraEntry: CameraEntry,
    task: ChildProcessWithoutNullStreams | undefined): Promise<ChildProcessWithoutNullStreams | undefined> {
    
    const name = cameraEntry.name;
    const enabled = cameraEntry.enable_streaming;
    const streamFile = `${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`;
    const checkAfter = 10; // Check health every 10 seconds

    // Protects duplicate running if this function takes longer than 1 second
    if (processControllerFFmpeg_inprogress[name]?.inprogress) {
        logger.debug('processControllerFFmpeg already in progress', { name });
        return task
    }
    
    // Initialize or update progress tracking
    if (!processControllerFFmpeg_inprogress[name]) {
        processControllerFFmpeg_inprogress[name] = { inprogress: true, checkFrom: Date.now() };
    } else {
        processControllerFFmpeg_inprogress[name].inprogress = true;
    }

    // No streaming enabled, and process is running then kill it
    if (!enabled) {
        if (task && task.exitCode === null) {
            task.kill();
        }
        processControllerFFmpeg_inprogress[name].inprogress = false;
        return task
    }

    if (task && task.exitCode ===  null) {
        // if its reporting running good, but is it time to check the output?
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (checkAfter && (processControllerFFmpeg_inprogress[name].checkFrom + (checkAfter * 1000)) < Date.now())   {
            processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], checkFrom: Date.now()}
            try {
                const {mtimeMs, size} = await fs.stat(streamFile),
                        last_updated_ago = Date.now() - mtimeMs

                if (size === 0) {
                    logger.warn('Process producing empty file - killing', { name, file: streamFile, size });
                    task.kill();
                } else if (last_updated_ago > 10000 /* 10 seconds */) {
                    logger.warn('Process hung - killing', { name, file: streamFile, lastUpdate: `${last_updated_ago}ms` });
                    // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                    task.kill();
                } else {
                    // its running fine, recheck in 30secs
                    processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false }
                    return task
                }
            } catch (e) {
                logger.warn('Cannot access process output - killing', { name, file: streamFile, error: String(e) });
                // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                task.kill();
            }

        } else {
            // still running, not time to check yet
            processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false }
            return task
        }
    } else if (task) {
        // Don't restart if shutting down
        if (isShuttingDown) {
            logger.info('Skipping process restart - shutdown in progress', { name });
            processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
            return null;
        }
        
        logger.warn('Process not running - restarting', { name, exitCode: task.exitCode });
    }

    try {
        logger.info('Starting streaming process', { name, pid: 'pending' });
        
        const cmdArgs = [
            '-rtsp_transport', 'tcp',
            '-reorder_queue_size', '500',
            '-max_delay', '500000',
            '-i', `rtsp://admin:${cameraEntry.passwd}@${cameraEntry.ip}:554/h264Preview_01_main`,
            '-hide_banner',
            '-loglevel', 'error',
            '-vcodec', 'copy',
            '-start_number', ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH).toString(),
            streamFile
        ];
        
        const childProcess = spawnProcess({
            name,
            cmd: '/usr/bin/ffmpeg',
            args: cmdArgs,
            captureOutput: true,
            onStderr: (data: string) => {
                const output = data.toString().trim();
                if (output) {
                    logger.error('ffmpeg streaming error', { name, data: output });
                }
            },
            onClose: (code: number | null, signal: string | null) => {
                if (code !== 0 && code !== null && signal === null) {
                    logger.error('Streaming process exited unexpectedly', { 
                        name, 
                        exitCode: code,
                        willRestart: 'on next cycle'
                    });
                } else if (signal) {
                    logger.info('Streaming process terminated by signal', { name, signal });
                }
            }
        });
  
        // Verify stream startup
        const verification = await verifyStreamStartup({
            processName: name,
            process: childProcess,
            outputFilePath: streamFile,
                maxWaitTimeMs: 10000,
                maxFileAgeMs: 5000,
                checkIntervalMs: 1000
            });
            
            if (!verification.ready) {
                // Stream verification failed
                logger.error('Stream startup failed - killing process', { 
                    name, 
                    verification,
                    processRunning: childProcess.exitCode === null 
                });
                
                // Kill the process if it's still running
                if (childProcess.exitCode === null) {
                    try {
                        childProcess.kill();
                        // Wait a bit for graceful shutdown
                        await new Promise((res) => setTimeout(res, 2000));
                        if (childProcess.exitCode === null) {
                            childProcess.kill('SIGKILL');
                        }
                    } catch (e) {
                        logger.error('Failed to kill failed stream process', { name, error: String(e) });
                    }
                }
                
                processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
                return undefined;
            }
            
        // Additional verification: check file is still fresh after startup
        await new Promise((res) => setTimeout(res, 2000));
        try {
            const {mtimeMs} = await fs.stat(streamFile);
                const fileAge = Date.now() - mtimeMs;
                
                if (fileAge > 10000) {
                    logger.error('Stream startup succeeded but file is now stale', { 
                        name, 
                        fileAge: `${fileAge}ms`,
                        willKill: true
                    });
                    
                    if (childProcess.exitCode === null) {
                        childProcess.kill();
                    }
                    
                    processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
                    return undefined;
                }
                
                logger.info('Stream startup confirmed healthy', { 
                    name, 
                    pid: childProcess.pid,
                    fileAge: `${fileAge}ms`
                });
            } catch (e) {
                logger.error('Stream output file disappeared after startup', { 
                    name, 
                    error: String(e)
                });
                
                if (childProcess.exitCode === null) {
                    childProcess.kill();
                }
                
                processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
                return undefined;
            }
        
        processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
        return childProcess;

    } catch (e) {
        logger.error('processControllerFFmpeg error', { name, error: String(e) });
        processControllerFFmpeg_inprogress[name] = {...processControllerFFmpeg_inprogress[name], inprogress: false };
        return undefined;
    }
}


const PORT = process.env['PORT'] || 8080

/**
 * Get the frames output path based on settings
 */
function getFramesPath(disk: string, folder: string): string {
    const baseDir = settingsCache.settings.disk_base_dir || disk;
    return settingsCache.settings.detection_frames_path 
        ? `${baseDir}/${settingsCache.settings.detection_frames_path}`.replace(/\/+/g, '/')
        : `${disk}/${folder}`;
}

async function ensureDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder)
        if (!stat.isDirectory()) {
            throw new Error(`${folder} is not a directory`)
        }
        return true
    } catch (e) {
        if (e.code === 'ENOENT') {
            try {
                await fs.mkdir(folder)
                return true
            } catch (e) {
                throw new Error(`Cannot create ${folder}: ${e}`)
            }
        } else {
            throw new Error(`Cannot stat ${folder}: ${e}`)
        }
    }
}

async function init_web() {

    var assets = new Router()
        .get('/image/:moment', async (ctx, _next) => {
            const moment = ctx.params['moment']

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)))
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const c: CameraEntry = await cameradb.get(m.cameraKey)
                if (!c) {
                    ctx.throw(404, `Camera not found: ${m.cameraKey}`);
                    return;
                }
                const hasDetections = m.detection_output?.tags && m.detection_output.tags.length > 0;
                const serve = `${c.disk}/${c.folder}/${hasDetections ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await fs.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined })
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/frame/:moment/:filename', async (ctx, _next) => {
            const moment = ctx.params['moment']
            const filename = ctx.params['filename']

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)))
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const { disk, folder } = cameraCache[m.cameraKey].cameraEntry;
                const framesPath = getFramesPath(disk, folder);
                
                const serve = `${framesPath}/${filename}`;
                const { size } = await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                const err : Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/video/live/:cameraKey/:file', async (ctx, _next) => {
            const cameraKey = ctx.params['cameraKey'],
                  file = ctx.params['file']

            try {
                const c = await cameradb.get(cameraKey)
                if (!c) {
                    ctx.throw(404, `Camera not found: ${cameraKey}`);
                    return;
                }
                const serve = `${c.disk}/${c.folder}/${file}`
                const { size } = await fs.stat(serve)
                //console.log(`serving : ${serve}`)

                if (file.endsWith('.m3u8')) {
                    ctx.set('content-type', 'application/x-mpegURL')
                } else if (file.endsWith('.ts')) {
                    ctx.set('content-type', 'video/MP2T')
                } else {
                    ctx.throw(400, `unknown file=${file}`)
                }

                ctx.body = createReadStream(serve)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/video/:startSegment/:seconds/:cameraKey/:file', async (ctx, _next) => {
            const 
                startSegment = ctx.params['startSegment'],
                seconds = ctx.params['seconds'],
                cameraKey = ctx.params['cameraKey'],
                file = ctx.params['file']

            const cameraEntry: CameraEntry = cameraCache[cameraKey].cameraEntry
            
            if (file.endsWith('.m3u8')) {
                const segmentInt = parseInt(startSegment)//.getTime()
                const secondsInt = parseInt(seconds)//.getTime()
                if (isNaN(segmentInt) || isNaN(secondsInt) ) {
                    ctx.throw(400, `message=${startSegment} or ${seconds} not valid values`)
                } else {
                    //const startSegment = segment // (d / 1000 | 0) - 1600000000
                    const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0
                    const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0

                    // Calculate number of segments (minimum 1 for very short movements)
                    const numSegments = Math.max(1, Math.round(secondsInt / 2) + preseq + postseq);
                    
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
#EXT-X-TARGETDURATION:2
` + [...Array(numSegments).keys()].map(n => `#EXTINF:2.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"
    
                    ctx.set('content-type', 'application/x-mpegURL')
                    ctx.body = body
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/${file}`
                try {
                    const { size } = await fs.stat(serve)
                    ctx.set('content-type', 'video/MP2T')
                    ctx.body = createReadStream(serve)
                } catch (e) {
                    const err : Error = e as Error
                    logger.warn('Video segment not found', { 
                        file, 
                        path: serve, 
                        cameraKey, 
                        error: err.message 
                    });
                    ctx.throw(404, `Segment not found: ${file}`)
                }
            } else {
                ctx.throw(400, `unknown file=${file}`)
            }
        })

        .get('/mp4/:startSegment/:seconds/:cameraKey', async (ctx, _next) => {
            const 
                startSegment = ctx.params['startSegment'],
                seconds = ctx.params['seconds'],
                cameraKey = ctx.params['cameraKey']

            try {
                const cameraEntry: CameraEntry = await cameraCache[cameraKey].cameraEntry

                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/save${startSegment}-${seconds}.mp4`

                const result = await runProcess({
                    name: `mp4-gen-${cameraKey}-${startSegment}`,
                    cmd: '/usr/bin/ffmpeg',
                    args: ['-y', '-i', `http://localhost:${PORT}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${preseq > 0 || postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve],
                    timeout: 50000
                });

                if (result.code !== 0) {
                    throw new Error(`ffmpeg failed with code ${result.code}: ${result.stderr}`);
                }

                ctx.set('Content-Type', 'video/mp4')
                ctx.body = createReadStream(serve, { encoding: undefined })

            } catch (e) {
                ctx.throw(`error mp4 gen error=${e}`)
            }

        })


        .get('{/*path}', async (ctx, _next) => {
            const path = ctx.params['path']
            logger.debug('Serving static file', { path });
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/settings', async (ctx, _next) => {
            logger.info('Settings save', { settings: ctx.request.body });
            if (ctx.request.body) {
                const new_settings: Settings = ctx.request.body as Settings
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir)
                    if (!dirchk.isDirectory())  throw new Error(`${new_settings.disk_base_dir} is not a directory`)
                    await settingsdb.put('config', new_settings)
                    settingsCache = {...settingsCache, settings: new_settings, status: {...settingsCache.status, nextCheckInMinutes:  new_settings.disk_cleanup_interval }}
                    ctx.status = 201
                } catch (err) {
                    ctx.body = err
                    ctx.status = 500
                }
            } else {
                ctx.body = 'no body'
                ctx.status = 500
            }
        })
        .post('/camera/:id', async (ctx, _next) => {
            
            const cameraKey = ctx.params['id']
            const deleteOption = ctx.request.query['delopt']

            logger.info('Camera save', { cameraKey, deleteOption, camera: ctx.request.body });
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body as CameraEntry
                const folder = `${new_ce.disk}/${new_ce.folder}`
                if (cameraKey === 'new') {
                    // creating new entry
                    try {
                        await ensureDir(folder)
                        const new_key = "C" + ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH)
                        await cameradb.put(new_key, {delete: false, ...new_ce} as CameraEntry)
                        cameraCache[new_key] = {cameraEntry: new_ce }
                        ctx.status = 201
                    } catch (e) {
                        ctx.throw(400, e)
                    }
                    
                } else {

                    // updating existing camera
                    try {
                        const old_cc: CameraCacheEntry = cameraCache[cameraKey] 
                        if (!old_cc) throw new Error(`camera ${cameraKey} not found`)

                        if (!deleteOption) {
                            await ensureDir(folder)
                        }

                        // Stop old camera definition movements and ffmpeg gracefully
                        logger.info('Stopping existing camera processes', { 
                            camera: old_cc.cameraEntry.name, 
                            cameraKey,
                            hasFFmpegTask: !!old_cc.ffmpeg_task 
                        });
                        
                        // Disable streaming to prevent restarts
                        cameraCache[cameraKey] = { 
                            ...cameraCache[cameraKey],
                            cameraEntry: {...old_cc.cameraEntry, enable_streaming: false},
                        }
                        
                        // Gracefully terminate ffmpeg if running
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
                                }, 5000); // 5 second timeout
                                
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
                        } else {
                            logger.debug('No running ffmpeg process to terminate', {
                                camera: old_cc.cameraEntry.name,
                                cameraKey
                            });
                        }

                        if (!deleteOption) {
                            const new_vals: CameraEntry = {...old_cc.cameraEntry, ...new_ce}
                            await cameradb.put(cameraKey, new_vals) 
                            cameraCache[cameraKey] = { cameraEntry: new_vals }
                            
                            logger.info('Camera configuration updated', {
                                camera: new_vals.name,
                                cameraKey,
                                streaming: new_vals.enable_streaming,
                                movement: new_vals.enable_movement
                            });
                            
                            // Restart movement detection controller if enabled
                            if (new_vals.enable_movement) {
                                startProcessingController(cameraKey);
                            } else {
                                stopProcessingController(cameraKey);
                            }
                            
                            ctx.status = 201
                        } else {
                            logger.info('Camera operation', {
                                camera: old_cc.cameraEntry.name,
                                cameraKey,
                                deleteOption
                            });
                            
                            if (deleteOption === 'reset') {
                                // Reset camera: delete movements and files, reset cursor
                                logger.info('Resetting camera recordings', { cameraKey });
                                
                                // Delete all movement files
                                const diskres = await clearDownDisk(settingsCache.settings.disk_base_dir, [cameraKey], -1)
                                logger.info('Camera movement files deleted', { cameraKey, diskres });
                                
                                // Delete all movement database entries for this camera
                                const movementsToDelete: string[] = [];
                                for await (const [key, movement] of movementdb.iterator()) {
                                    if (movement.cameraKey === cameraKey) {
                                        movementsToDelete.push(key);
                                    }
                                }
                                
                                for (const key of movementsToDelete) {
                                    await movementdb.del(key);
                                }
                                
                                logger.info('Camera movements deleted from database', { 
                                    cameraKey, 
                                    count: movementsToDelete.length 
                                });
                                
                                // Reset processing cursor
                                try {
                                    await cursordb.del(cameraKey);
                                    logger.info('Camera cursor reset', { cameraKey });
                                } catch (e) {
                                    logger.debug('No cursor to reset', { cameraKey });
                                }
                                
                                ctx.status = 200;
                                
                            } else if (deleteOption === 'delall') {
                                //delete all camera files
                                const diskres = await clearDownDisk(settingsCache.settings.disk_base_dir, [cameraKey], -1)
                                logger.info('Camera files deleted', { cameraKey, diskres });
                            }
                            
                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                //delete camera entry
                                const new_vals: CameraEntry = {...old_cc.cameraEntry, delete: true}

                                await cameradb.put(cameraKey, new_vals) 
                                cameraCache[cameraKey] = { cameraEntry: new_vals }
                                
                                logger.info('Camera marked as deleted', {
                                    camera: new_vals.name,
                                    cameraKey
                                });
                                
                                ctx.status = 200
                            } else if (deleteOption !== 'reset') {
                                logger.warn('Unknown delete option', { deleteOption });
                                ctx.status = 400
                            }
                        }
   
                    } catch (e) {
                        logger.error('Camera update error', { error: String(e) });
                        ctx.throw(400, e)
                    }

                }
            } else {
                ctx.status = 500
            }
        }).get('/movements/stream', (ctx, _next) => {
            // SSE endpoint for real-time movement updates
            sseManager.addClient(ctx);
        }).get('/movements', async (ctx, _next) => {
            const mode = ctx.query['mode'] 
            const cameras: CameraEntryClient[] = Object.entries(cameraCache).filter(([_, value]) => !value.cameraEntry.delete).map(([key, value]) => {

               const { cameraEntry } = value

                // Filter out data not for the client
                const {ip, passwd, ...clientCameraEntry} = cameraEntry

                return {key, ...clientCameraEntry} as CameraEntryClient
            })

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res, _rej) => {

                let movements: MovementToClient[] = []

                if (mode === "Time") {

                    for (let c of cameras) {
                        const listfiles = await catalogVideo(`${c.disk}/${c.folder}`)
                        for (let i = listfiles.length - 1; i >= 0; i--) {
                            const segs = listfiles[i]
                            movements.push({
                                key: parseInt(c.key.slice(1) + segs.segmentStart),
                                startDate_en_GB: segs.startDate_en_GB,
                                movement: {
                                    cameraKey: c.key,
                                    startDate: segs.ctimeMs,
                                    startSegment: segs.segmentStart,
                                    seconds: segs.seconds
                                }
                            })
                        }
                    }
                    res({ config: settingsCache, cameras, movements })
                } else {
                    

                    // Everything in movementdb, with key time (movement start date) greater than the creation date of the oldest sequence file on disk
                    for await (const [encodedKey, value] of movementdb.iterator({ reverse: true })) {
                        const key = decodeMovementKey(encodedKey);
                        const { detection_output, cameraKey } = value

                        let tags = detection_output?.tags || null
                        if (mode === 'Filtered') {
                            const { detection_tag_filters } = settingsCache.settings || {}
                            if (!detection_tag_filters || detection_tag_filters.length === 0) {
                                // No filters configured - hide all movements in filtered mode
                                tags = []
                            } else if (tags && Array.isArray(tags) && tags.length > 0) {
                                // Only show tags that meet their minimum probability threshold
                                tags = tags.filter(t => {
                                    const filter = detection_tag_filters.find(f => f.tag === t.tag)
                                    return filter ? t.maxProbability >= filter.minProbability : false
                                })
                            } else {
                                // No tags on this movement - don't show in filtered mode
                                tags = []
                            }
                        }
                        if (mode === 'Movement' || (mode === 'Filtered' && tags && tags.length > 0)) {
                            if (!value.startDate || isNaN(value.startDate)) continue;
                            const startDate = new Date(value.startDate);
                            if (isNaN(startDate.getTime())) continue;
                            
                            movements.push({
                                key,
                                startDate_en_GB: new Intl.DateTimeFormat('en-GB', { ...(startDate.toDateString() !== (new Date()).toDateString() && {weekday: "short"}), minute: "2-digit", hour: "2-digit",  hour12: true }).format(startDate),
                                movement: {
                                    cameraKey: value.cameraKey,
                                    startDate: value.startDate,
                                    startSegment: value.startSegment,
                                    seconds: value.seconds,
                                    detection_status: value.detection_status || 'complete',  // Always include status
                                    processing_state: value.processing_state,
                                    ...(tags && tags.length > 0 && { detection_output: { tags } })
                                }
                            })
                        }
                    }
                    res({ config: settingsCache, cameras, movements })
                }
            })

        })

    const nav = new Router()
        .get('/network', async (ctx, _next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3998`)
        })
        .get('/metrics', async (ctx, _next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3000/d/T3OrKihMk/our-house?orgId=1`)
        })

    const app = new Koa()
    
    // Global error handler - suppress premature close errors from client disconnects
    app.on('error', (err, ctx) => {
        // Ignore client disconnect errors (ECONNRESET, EPIPE, ERR_STREAM_PREMATURE_CLOSE)
        if (err.code === 'ECONNRESET' || 
            err.code === 'EPIPE' || 
            err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            err.message?.includes('Premature close')) {
            // These are normal when clients cancel video requests
            logger.debug('Client disconnected', { 
                path: ctx.path, 
                error: err.code || err.message 
            });
            return;
        }
        
        // Log actual errors
        logger.error('Application error', { 
            error: err.message, 
            stack: err.stack,
            path: ctx.path,
            method: ctx.method
        });
    });
    
    app.use(bodyParser())
    app.use(api.routes())
    app.use(nav.routes())
    app.use(assets.routes())

    logger.info('NVR Server starting', { port: 8080 });
    app.listen(8080)
}


async function clearDownDisk(diskDir: string, cameraKeys : Array<string>, cleanupCapacity: number) : Promise<DiskCheckReturn> {
    // Include camera folders and ML frames folder (if configured separately)
    const cameraFolders = cameraKeys.map(key => `${diskDir}/${cameraCache[key].cameraEntry.folder}`);
    const mlFramesFolder = settingsCache.settings.detection_frames_path 
        ? `${diskDir}/${settingsCache.settings.detection_frames_path}`.replace(/\/+/g, '/')
        : null;
    
    // Add frames folder if it's different from camera folders
    const foldersToClean = mlFramesFolder && !cameraFolders.includes(mlFramesFolder)
        ? [...cameraFolders, mlFramesFolder]
        : cameraFolders;
    
    const diskres = await diskCheck(diskDir, foldersToClean, cleanupCapacity)
    logger.info('Disk check complete', diskres);
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce((acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs ? (  diskres.folderStats[cur].lastRemovedctimeMs > acc? diskres.folderStats[cur].lastRemovedctimeMs : acc ) : acc ,0)
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            const keytoDeleteTo =  cleanupCapacity === -1 ? null : encodeMovementKey((mostRecentctimMs / 1000 | 0) - MOVEMENT_KEY_EPOCH)
            const deleteKeys : Array<string> = []
            for await (const [encodedKey, value] of movementdb.iterator(keytoDeleteTo ? {lte: keytoDeleteTo} : {})) {
                if (cameraKeys.includes(value.cameraKey)) {
                    deleteKeys.push(encodedKey)
                }
            }

            if (deleteKeys.length > 0) {
                logger.info('Deleting old movements', { count: deleteKeys.length });
                await movementdb.batch(deleteKeys.map(k => ({ type: 'del', key: k })) as any)
            }

        }
    }
    return diskres
}

async function main() {

    //const jobman = new JobManager(db, 1, jobWorker)
    //jobman.start(false)

    // Populate cameraCache
    for await (const [key, value] of cameradb.iterator()) {
        cameraCache[key] = {cameraEntry: value}
    }

    // Populate settingsCache with defaults
    settingsCache = {settings: { disk_base_dir: '', detection_model:'', detection_target_hw:'', detection_frames_path:'', detection_enable: false, detection_tag_filters: [], disk_cleanup_interval: 0, disk_cleanup_capacity: 90}, status: { fail: false, nextCheckInMinutes: 0}}
    const savedSettings = await settingsdb.get('config');
    if (savedSettings) {
        settingsCache = {...settingsCache, settings: savedSettings};
    }
    
    // Reset any stale processing locks from previous server instance
    await resetStaleProcessingLocks();

    // Initialize process utilities with dependencies
    setDependencies({
        settingsCache,
        movementdb,
        sendImageToMLDetection,
        getShuttingDown: () => isShuttingDown
    });

    // Start the Camera controll loop (ensuring ffmpeg is running, and checking movement) ()
    setInterval(async () => {
        // Manage ML detection process lifecycle
        await processControllerDetector();

        const cameraKeys = Object.keys(cameraCache);
        if (cameraKeys.length === 0) {
            // Only log this once per minute to avoid spam
            if (!global.lastNoCameraLog || Date.now() - global.lastNoCameraLog > 60000) {
                logger.warn('No cameras configured');
                global.lastNoCameraLog = Date.now();
            }
        }

        for (let cKey of cameraKeys) {

            const {cameraEntry, ffmpeg_task } = cameraCache[cKey]

            if (!cameraEntry.delete) {
                const task = await processControllerFFmpeg(cameraEntry, ffmpeg_task);
                cameraCache[cKey] = {...cameraCache[cKey], ffmpeg_task: task};
                
                const streamFile = `${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`
                    
                // Process movement detection if streaming is active and movement detection is enabled
                if (cameraEntry.enable_movement && cameraCache[cKey].ffmpeg_task && cameraCache[cKey].ffmpeg_task.exitCode === null) {
                    // Check if enough time has passed since last movement check
                    const now = Date.now();
                    const lastCheck = cameraCache[cKey].lastMovementCheck || 0;
                    const pollInterval = cameraEntry.mSPollFrequency || 1000; // Default 1 second if not set
                    
                    if (now - lastCheck >= pollInterval) {
                        cameraCache[cKey] = {...cameraCache[cKey], lastMovementCheck: now};
                        await detectCameraMovement(cKey);
                    }
                    
                    // Ensure processing controller is running
                    if (!processingIntervals.has(cKey)) {
                        startProcessingController(cKey);
                    }
                } else {
                    // Movement detection disabled - stop processing controller
                    if (processingIntervals.has(cKey)) {
                        stopProcessingController(cKey);
                    }
                    
                    if (!cameraEntry.enable_movement) {
                        // Only log once per minute to avoid spam
                        if (!global[`lastMovementDisabledLog_${cKey}`] || Date.now() - global[`lastMovementDisabledLog_${cKey}`] > 60000) {
                            logger.debug('Movement detection disabled', { camera: cameraEntry.name });
                            global[`lastMovementDisabledLog_${cKey}`] = Date.now();
                        }
                    }
                }
            }
        }
    }, 1000)

    // Keep-alive for SSE connections (every 30 seconds)
    setInterval(() => {
        if (sseManager.getClientCount() > 0) {
            sseManager.sendKeepAlive();
        }
    }, 30000);

    // Start the Disk controll loop, checking space and cleaning up disk and movements db
    setInterval(async () => {
        const { settings, status} = settingsCache

        if (status.nextCheckInMinutes === 0) {
            settingsCache = {...settingsCache, status: {...status, nextCheckInMinutes: settings.disk_cleanup_interval}}
            if (settings.disk_cleanup_interval > 0 && settings.disk_base_dir) {
                try {
                    const diskres = await clearDownDisk(settings.disk_base_dir, Object.keys(cameraCache).filter(c => (!cameraCache[c].cameraEntry.delete) && cameraCache[c].cameraEntry.enable_streaming), settings.disk_cleanup_capacity )
                    settingsCache = {...settingsCache, status: {...status, fail:false, error: '',  ...diskres, lastChecked: new Date()}}
                } catch(e) {
                    logger.error('Disk cleanup error', { error: String(e) });
                    settingsCache = {...settingsCache, status: {...status, fail: true, error: e?.message, lastChecked: new Date()}}
                }
            }
        } else {
            settingsCache = {...settingsCache, status: {...status,  nextCheckInMinutes: status.nextCheckInMinutes - 1}}
        }
    }, 60000)

    init_web()

    // Register graceful shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon
    
    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error: Error) => {
        logger.error('Uncaught exception - initiating shutdown', { 
            error: error.message, 
            stack: error.stack 
        });
        gracefulShutdown('uncaughtException').then(() => process.exit(1));
    });
    
    process.on('unhandledRejection', (reason: any) => {
        logger.error('Unhandled rejection - initiating shutdown', { 
            reason: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined
        });
        gracefulShutdown('unhandledRejection').then(() => process.exit(1));
    });
    
    logger.info('Shutdown handlers registered', { 
        signals: ['SIGTERM', 'SIGINT', 'SIGUSR2', 'uncaughtException', 'unhandledRejection'] 
    });

    //db.close()
}

main()
