const
    Koa = require('koa'),
    send = require('koa-send'),
    lexint = require('lexicographic-integer')

import fs from 'fs/promises'
import { createReadStream } from 'fs'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import level from 'level'
import sub from 'subleveldown'
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
    ProcessSpawnOptions
} from './process-utils.js'

// Initialize utilities with logger
setLogger(logger);


interface Settings {
    disk_base_dir: string;
    cleanup_interval: number;
    cleanup_capacity: number;
    enable_ml: boolean;
    mlModel: string;
    mlTarget: string;
    mlFramesPath: string;
    labels: string;
    tag_filters: TagFilter[];
}

interface TagFilter {
    tag: string;
    minProbability: number;
}
interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number;
    lhs_seg_duration_seq?: number;
    seconds: number;
    pollCount: number;
    consecutivePollsWithoutMovement: number;
    detection_status?: string;  // 'starting', 'extracting', 'analyzing', or undefined when complete
    detection_output?: DetectionOutput;
}

interface MovementToClient {
    key: number;
    movement: {
        cameraKey: string;
        startDate: number;
        startSegment: number;
        seconds: number;
        detection_status?: string;
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
/* 
interface ProcessInfo {
    check_after?: number;
    in_progress: boolean;
    error: boolean;
    running: boolean;
    status: string;
    taskid?: ChildProcessWithoutNullStreams;
}
 */
interface MovementStatus {
    control: ExecuteControl;
    status?: string;
    current_key?: number;
    current_taskid?: ChildProcessWithoutNullStreams;
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
    ffmpeg_task?: ChildProcessWithoutNullStreams;
    movementStatus?: MovementStatus;
    lastMovementCheck?: number;  // Track last time we checked for movement
}

interface CameraCache { 
    [key: string]: CameraCacheEntry;
}
var cameraCache: CameraCache = {}

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

const db = level(process.env['DBPATH'] || './mydb',  { valueEncoding : 'json' })
const cameradb = sub(db, 'cameras', { valueEncoding : 'json' })
const movementdb = sub(db, 'movements', {
    valueEncoding : 'json',
    keyEncoding: {
        type: 'lexicographic-integer',
        encode: (n) => lexint.pack(n, 'hex'),
        decode: lexint.unpack,
        buffer: false
    }
})

// Epoch offset for movement keys (Sept 13, 2020)
const MOVEMENT_KEY_EPOCH = 1600000000;

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
    
    const shutdownPromises: Promise<void>[] = [];
    
    // Stop all camera ffmpeg processes
    for (const cameraKey of Object.keys(cameraCache)) {
        const { ffmpeg_task, cameraEntry, movementStatus } = cameraCache[cameraKey];
        
        if (ffmpeg_task && ffmpeg_task.exitCode === null) {
            logger.info('Stopping ffmpeg process', { camera: cameraEntry.name, pid: ffmpeg_task.pid });
            
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
                    logger.info('ffmpeg process terminated', { camera: cameraEntry.name });
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
        
        // Stop any ongoing movement detection ffmpeg processes
        if (movementStatus?.current_taskid && movementStatus.current_taskid.exitCode === null) {
            logger.info('Stopping movement detection process', { 
                camera: cameraEntry.name, 
                pid: movementStatus.current_taskid.pid 
            });
            
            const promise = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn('Movement process did not terminate in time - forcing', { 
                        camera: cameraEntry.name, 
                        pid: movementStatus.current_taskid.pid 
                    });
                    try {
                        movementStatus.current_taskid.kill('SIGKILL');
                    } catch (e) {
                        logger.error('Failed to force kill movement process', { error: String(e) });
                    }
                    resolve();
                }, 5000);
                
                movementStatus.current_taskid.once('close', () => {
                    clearTimeout(timeout);
                    logger.info('Movement process terminated', { camera: cameraEntry.name });
                    resolve();
                });
                
                try {
                    movementStatus.current_taskid.kill();
                } catch (e) {
                    logger.error('Failed to kill movement process', { error: String(e) });
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

// Function to send image path to ML detection process
function sendImageToMLDetection(imagePath: string, movement_key: number): void {
    if (mlDetectionProcess && mlDetectionProcess.stdin && !mlDetectionProcess.killed) {
        try {
            const imageName = imagePath.split('/').pop() || imagePath;
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
            const movement: MovementEntry = await movementdb.get(movement_key);
            
            // Get existing tags or initialize empty
            const existingTags = movement.detection_output?.tags || [];
            
            // Convert existing tags to a map for easy lookup
            const tagsMap: { [key: string]: MLTag } = {};
            existingTags.forEach(tag => {
                tagsMap[tag.tag] = tag;
            });
            
            // Process all detections for this image
            for (const detection of result.detections) {
                const objectType = detection.object;
                const probability = detection.probability;
                
                logger.info('Detection received from ML', { 
                    frame: imageName, 
                    movement: movement_key, 
                    object: objectType, 
                    probability: `${(probability * 100).toFixed(1)}%` 
                });
                
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
            await movementdb.put(movement_key, {
                ...movement,
                detection_status: undefined,  // Clear status once we have results to show
                detection_output: {
                    tags: updatedTags
                }
            });
            
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
        const movement: MovementEntry = await movementdb.get(movement_key);
        
        // Mark ML processing as complete (results already in database from processDetectionResult)
        await movementdb.put(movement_key, {
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

 // Called every second for each camera, to process movement

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
                      movement_key = (startDate / 1000 | 0) - MOVEMENT_KEY_EPOCH,
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
                    mlEnabled: settingsCache.settings.enable_ml
                });

                // Update status to 'extracting' after a short delay to ensure ffmpeg has started
                setTimeout(async () => {
                    if (settingsCache.settings.enable_ml) {
                        try {
                            const m = await movementdb.get(movement_key);
                            await movementdb.put(movement_key, {
                                ...m,
                                detection_status: 'extracting'
                            });
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
                        if (settingsCache.settings.enable_ml) {
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

                await movementdb.put(movement_key, {
                    cameraKey,
                    startDate,
                    startSegment,
                    lhs_seg_duration_seq,
                    seconds: 0,
                    pollCount: 1,
                    consecutivePollsWithoutMovement: 0,
                    detection_status: settingsCache.settings.enable_ml ? 'starting' : undefined
                })

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {current_key: movement_key, current_taskid: ffmpeg, status: "New movement detected", control: {...control, fn_not_finished: false}}}

            } else {
                // continuatation of same movment event
                const m: MovementEntry = await movementdb.get(current_key)
                
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
                    if (settingsCache.settings.enable_ml) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finished: false}}}
                    
                } else {
                    logger.debug('Movement continuation', { camera: cameraEntry.name, duration: `${durationSeconds}s` });
                    await movementdb.put(current_key, {...m, seconds: durationSeconds, pollCount: updatedPollCount, consecutivePollsWithoutMovement: 0})
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "Movement Continuation", control: {...control, fn_not_finished: false}}}
                }

            }
        } else {
            // no movement from camera
            if (current_key) {
                // got current movement
                const m: MovementEntry = await movementdb.get(current_key)
                
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
                    if (settingsCache.settings.enable_ml) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finished: false}}}
                    

                } else {
                    // still same movement, update elapsed time and consecutive polls without movement
                    await movementdb.put(current_key, {...m, seconds: elapsedSeconds, consecutivePollsWithoutMovement: consecutivePolls})
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

// run every second to start new cameras, and ensure steaming is working for running cameras
var processController_inprogress: { [key: string]: { inprogress: boolean; checkFrom: number } } = {};

async function processController(
    name: string,
    enabled: boolean, 
    cmd: string, cmdArgs: Array<string>, 
    [checkAfter, checkFilePath]: [checkAfter: number, checkFilePath: string], 
    task: ChildProcessWithoutNullStreams,
    cwd?: string): Promise<ChildProcessWithoutNullStreams | undefined> {
    
    //console.log (`processController for [${name}], called with [pid=${task?.pid}] [exit code=${task?.exitCode}]`)

    // Protects duplicate running if this function takes longer than 1 second
    if (processController_inprogress[name]?.inprogress) {
        logger.debug('processController already in progress', { name });
        return task
    }
    
    // Initialize or update progress tracking
    if (!processController_inprogress[name]) {
        processController_inprogress[name] = { inprogress: true, checkFrom: Date.now() };
    } else {
        processController_inprogress[name].inprogress = true;
    }


    // No streaming enabled, and processes is running then kill it
    if (!enabled) {
        if (task && task.exitCode === null) {
            task.kill();
        }
        return task
    }

    if (task && task.exitCode ===  null) {
        // if its reporting running good, but is it time to check the output?
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (checkAfter && (processController_inprogress[name].checkFrom + (checkAfter * 1000)) < Date.now())   {
            processController_inprogress[name] = {...processController_inprogress[name], checkFrom: Date.now()}
            logger.debug('Checking process output', { name });
            try {
                const {mtimeMs} = await fs.stat(checkFilePath),
                        last_updated_ago = Date.now() - mtimeMs

                if (last_updated_ago > 10000 /* 10 seconds */) {
                    logger.warn('Process hung - killing', { name, file: checkFilePath, lastUpdate: `${last_updated_ago}ms` });
                    // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                    task.kill();
                } else {
                    // its running fine, recheck in 30secs
                    logger.debug('Process healthy', { name, file: checkFilePath, lastUpdate: `${last_updated_ago}ms`, nextCheck: `${checkAfter}s` });
                    processController_inprogress[name] = {...processController_inprogress[name], inprogress: false }
                    return task
                }
            } catch (e) {
                logger.warn('Cannot access process output - killing', { name, file: checkFilePath, error: String(e) });
                // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                task.kill();
            }

        } else {
            // still running, not time to check yet
            processController_inprogress[name] = {...processController_inprogress[name], inprogress: false }
            return task
        }
    } else if (task) {
        logger.warn('Process not running - restarting', { name, exitCode: task.exitCode });
    }

    try {
        const workingDir = cwd || process.env['PWD'];
        
        logger.info('Starting streaming process', { name, pid: 'pending' });
        
        const childProcess = spawnProcess({
            name,
            cmd,
            args: cmdArgs,
            cwd: workingDir,
            captureOutput: true,
            onStderr: (data: string) => {
                const output = data.toString();
                
                // Filter out common RTSP startup warnings that are harmless
                const isRTSPStartupWarning = output.includes('RTP: PT=') && output.includes('bad cseq');
                const isH264DecodeWarning = output.includes('[h264 @') && 
                                           (output.includes('error while decoding MB') || 
                                            output.includes('left block unavailable'));
                
                // Check for critical errors
                const isCriticalError = output.includes('Connection refused') || 
                                       output.includes('Connection timed out') ||
                                       output.includes('Server returned 4') ||
                                       output.includes('Invalid data found');
                
                // Only log if it's not a known harmless startup warning
                if (isCriticalError) {
                    logger.error('Process critical error', { name, data: output.trim() });
                } else if (!isRTSPStartupWarning && !isH264DecodeWarning) {
                    logger.warn('Process stderr', { name, data: output.trim() });
                } else {
                    // Log at debug level for filtered warnings
                    logger.debug('Process stderr (filtered)', { name, data: output.trim() });
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
  
        // Verify stream startup if we have a file to check
        if (checkFilePath) {
            const verification = await verifyStreamStartup({
                processName: name,
                process: childProcess,
                outputFilePath: checkFilePath,
                maxWaitTimeMs: 10000,
                maxFileAgeMs: 5000,
                checkIntervalMs: 1000
            });
            
            if (!verification.ready && childProcess.exitCode !== null) {
                // Process died during startup
                logger.error('Stream startup failed', { name, verification });
                processController_inprogress[name] = {...processController_inprogress[name], inprogress: false };
                return undefined;
            }
        } else {
            // No output file to check, just wait a bit
            logger.info('Streaming process started (no verification)', { name, pid: childProcess.pid });
            await new Promise((res) => setTimeout(res, 2000));
        }
        
        processController_inprogress[name] = {...processController_inprogress[name], inprogress: false };
        return childProcess

    } catch (e) {
        logger.error('processController error', { name, error: String(e) });
        processController_inprogress[name] = {...processController_inprogress[name], inprogress: false };
        return undefined;
    }


}


const PORT = process.env['PORT'] || 8080

/**
 * Get the frames output path based on settings
 */
function getFramesPath(disk: string, folder: string): string {
    const baseDir = settingsCache.settings.disk_base_dir || disk;
    return settingsCache.settings.mlFramesPath 
        ? `${baseDir}/${settingsCache.settings.mlFramesPath}`.replace(/\/+/g, '/')
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
                const m: MovementEntry = await movementdb.get(parseInt(moment))
                const c: CameraEntry = await cameradb.get(m.cameraKey)
                const hasDetections = m.detection_output?.tags && m.detection_output.tags.length > 0;
                const serve = `${c.disk}/${c.folder}/${hasDetections ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await fs.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/frame/:moment/:filename', async (ctx, _next) => {
            const moment = ctx.params['moment']
            const filename = ctx.params['filename']

            try {
                const m: MovementEntry = await movementdb.get(parseInt(moment))
                const { disk, folder } = cameraCache[m.cameraKey].cameraEntry;
                const framesPath = getFramesPath(disk, folder);
                
                const serve = `${framesPath}/${filename}`;
                const { size } = await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror);
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

                ctx.body = createReadStream(serve).on('error', ctx.onerror)
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
                    ctx.body = createReadStream(serve).on('error', ctx.onerror)
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
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)

            } catch (e) {
                ctx.throw(`error mp4 gen error=${e}`)
            }

        })


        .get(['/(.*)'], async (ctx, _next) => {
            const path = ctx.params[0]
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
                    await db.put('settings', new_settings)
                    settingsCache = {...settingsCache, settings: new_settings, status: {...settingsCache.status, nextCheckInMinutes:  new_settings.cleanup_interval }}
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
                            
                            ctx.status = 201
                        } else {
                            if (deleteOption === 'delall') {
                                //delete all camera files
                                const diskres = await clearDownDisk(settingsCache.settings.disk_base_dir, [cameraKey], -1)
                            }
                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                //delete camera entry
                                const new_vals: CameraEntry = {...old_cc.cameraEntry, delete: true}

                                await cameradb.put(cameraKey, new_vals) 
                                cameraCache[cameraKey] = { cameraEntry: new_vals }
                                ctx.status = 200
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
        }).get('/movements', async (ctx, _next) => {
            const mode = ctx.query['mode'] 
            const cameras: CameraEntryClient[] = Object.entries(cameraCache).filter(([_, value]) => !value.cameraEntry.delete).map(([key, value]) => {

               const { movementStatus, cameraEntry /*, ffmpeg_process*/ } = value

                // filer out data not for the client
                const {ip, passwd, ...clientCameraEntry} = cameraEntry

                //const {taskid, ...clientFfmpeg_process} = ffmpeg_process || {}
                return {key, ...clientCameraEntry, /*ffmpeg_process: clientFfmpeg_process,*/ movementStatus} as CameraEntryClient
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
                    const feed = movementdb.createReadStream({ reverse: true /*, limit: 100*/ /*, gt: oldestctimeMs > 0 ? (oldestctimeMs / 1000 | 0) - 1600000000 : 0 */})
                        .on('data', (data) => {
                            const { key, value } = data as {key: number, value: MovementEntry}
                            const { detection_output, cameraKey } = value

                            let tags = detection_output?.tags || null
                            if (mode === 'Filtered') {
                                const { tag_filters } = settingsCache.settings || {}
                                if (!tag_filters || tag_filters.length === 0) {
                                    // No filters configured - hide all movements in filtered mode
                                    tags = []
                                } else if (tags && Array.isArray(tags) && tags.length > 0) {
                                    // Only show tags that meet their minimum probability threshold
                                    tags = tags.filter(t => {
                                        const filter = tag_filters.find(f => f.tag === t.tag)
                                        return filter ? t.maxProbability >= filter.minProbability : false
                                    })
                                } else {
                                    // No tags on this movement - don't show in filtered mode
                                    tags = []
                                }
                            }
                            if (mode === 'Movement' || (mode === 'Filtered' && tags && tags.length > 0)) {
                                const startDate = new Date(value.startDate)
                                movements.push({
                                    key,
                                    startDate_en_GB: new Intl.DateTimeFormat('en-GB', { ...(startDate.toDateString() !== (new Date()).toDateString() && {weekday: "short"}), minute: "2-digit", hour: "2-digit",  hour12: true }).format(startDate),
                                    movement: {
                                        cameraKey: value.cameraKey,
                                        startDate: value.startDate,
                                        startSegment: value.startSegment,
                                        seconds: value.seconds,
                                        detection_status: value.detection_status || 'complete',  // Always include status
                                        ...(tags && tags.length > 0 && { detection_output: { tags } })
                                    }
                                })
                            }
                        }).on('end', () => {
                            res({ config: settingsCache, cameras, movements })
                        })
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
    const mlFramesFolder = settingsCache.settings.mlFramesPath 
        ? `${diskDir}/${settingsCache.settings.mlFramesPath}`.replace(/\/+/g, '/')
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
            const keytoDeleteTo =  cleanupCapacity === -1 ? null : (mostRecentctimMs / 1000 | 0) - MOVEMENT_KEY_EPOCH
            const deleteKeys : Array<number> = await new Promise((res, _rej) => {
                let keys : Array<number> = []
                movementdb.createReadStream(keytoDeleteTo && {lte: keytoDeleteTo})
                .on('data', (data) => {
                    const { key, value } = data as {key: number, value: MovementEntry}
                    if (cameraKeys.includes(value.cameraKey)) {  
                        keys.push(key) 
                    }})
                .on('end', () => {
                    res(keys)
                })
            })

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
    await new Promise((res, _rej) => {
        cameradb.createReadStream()
            .on('data', (data) => {
                const { key, value } = data as {key: number, value: CameraEntry}
                cameraCache[key] = {cameraEntry: value}
            })
            .on('end', () => {
                res(0)
            })
    })

    // Populate settingsCache with default COCO labels
    const defaultLabels = "person,bicycle,car,motorbike,aeroplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,sofa,pottedplant,bed,diningtable,toilet,tvmonitor,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush";
    settingsCache = {settings: { disk_base_dir: '', mlModel:'', mlTarget:'', mlFramesPath:'', enable_ml: false, labels: defaultLabels, tag_filters: [], cleanup_interval: 0, cleanup_capacity: 90}, status: { fail: false, nextCheckInMinutes: 0}}
    try {
        settingsCache = {...settingsCache, settings : await db.get('settings') as Settings}
    } catch (e) {
        logger.warn('No settings defined yet');
    }

    // Initialize process utilities with dependencies
    setDependencies({
        settingsCache,
        movementdb,
        sendImageToMLDetection,
        getShuttingDown: () => isShuttingDown
    });

    // Start the Camera controll loop (ensuring ffmpeg is running, and checking movement) ()
    setInterval(async () => {
        // Start ML detection process if enabled
        const { settings } = settingsCache;
        if (settings.enable_ml && settings.mlModel) {
            const baseDir = process.env['PWD'] ;
            const aiDir = `${baseDir}/ai`;
            const modelPath =settings.mlModel;
            const cmdArgs = ['-u', '-m', 'detector.detect', '--model_path', modelPath];
            
            // Add target parameter if specified
            if (settings.mlTarget) {
                cmdArgs.push('--target', settings.mlTarget);
            }
            
            // Check if ML process needs to be started
            if (!mlDetectionProcess || mlDetectionProcess.exitCode !== null) {
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
                    model: settings.mlModel,
                    target: settings.mlTarget || 'default'
                });
            }
        }

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
                
                const streamFile = `${cameraEntry.disk}/${cameraEntry.folder}/stream.m3u8`
                const task = await processController(
                    cameraEntry.name, 
                    cameraEntry.enable_streaming, 
                    '/usr/bin/ffmpeg', 
                    [
                        '-rtsp_transport', 'tcp',
                        '-reorder_queue_size', '500',  // Buffer for packet reordering
                        '-max_delay', '500000',         // 500ms max delay for reordering (in microseconds)
                        '-i', `rtsp://admin:${cameraEntry.passwd}@${cameraEntry.ip}:554/h264Preview_01_main`,
                        '-hide_banner',
                        '-loglevel', 'error',
                        '-vcodec', 'copy',
                        '-start_number', ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH).toString(),
                        streamFile
                    ],
                    [ 60, streamFile ],
                    ffmpeg_task,
                    null
                )
                //console.log (`got task for [${cKey}] [pid=${task?.pid}] [exit code=${task?.exitCode}]`)
                cameraCache[cKey] =  {...cameraCache[cKey], ffmpeg_task: task }
                    
                // Process movement detection if streaming is active and movement detection is enabled
                if (cameraEntry.enable_movement && cameraCache[cKey].ffmpeg_task && cameraCache[cKey].ffmpeg_task.exitCode === null) {
                    // Verify stream is current before processing movement
                    const streamIsReady = await isStreamCurrent(streamFile, 10000);
                    
                    if (streamIsReady) {
                        // Check if enough time has passed since last movement check
                        const now = Date.now();
                        const lastCheck = cameraCache[cKey].lastMovementCheck || 0;
                        const pollInterval = cameraEntry.mSPollFrequency || 1000; // Default 1 second if not set
                        
                        if (now - lastCheck >= pollInterval) {
                            cameraCache[cKey] = {...cameraCache[cKey], lastMovementCheck: now};
                            await processMovement(cKey);
                        }
                    } else {
                        // Stream not ready - log periodically
                        if (!global[`lastStreamNotReadyLog_${cKey}`] || Date.now() - global[`lastStreamNotReadyLog_${cKey}`] > 60000) {
                            logger.warn('Stream not ready for movement detection', { 
                                camera: cameraEntry.name,
                                streamFile 
                            });
                            global[`lastStreamNotReadyLog_${cKey}`] = Date.now();
                        }
                    }
                } else if (!cameraEntry.enable_movement) {
                    // Only log once per minute to avoid spam
                    if (!global[`lastMovementDisabledLog_${cKey}`] || Date.now() - global[`lastMovementDisabledLog_${cKey}`] > 60000) {
                        logger.debug('Movement detection disabled', { camera: cameraEntry.name });
                        global[`lastMovementDisabledLog_${cKey}`] = Date.now();
                    }
                }
            }
        }
    }, 1000)

    // Start the Disk controll loop, checking space and cleaning up disk and movements db
    setInterval(async () => {
        const { settings, status} = settingsCache

        if (status.nextCheckInMinutes === 0) {
            settingsCache = {...settingsCache, status: {...status, nextCheckInMinutes: settings.cleanup_interval}}
            if (settings.cleanup_interval > 0 && settings.disk_base_dir) {
                try {
                    const diskres = await clearDownDisk(settings.disk_base_dir, Object.keys(cameraCache).filter(c => (!cameraCache[c].cameraEntry.delete) && cameraCache[c].cameraEntry.enable_streaming), settings.cleanup_capacity )
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
    
    logger.info('Shutdown handlers registered', { 
        signals: ['SIGTERM', 'SIGINT', 'SIGUSR2'] 
    });

    //db.close()
}

main()
