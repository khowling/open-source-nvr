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

import { JobManager, JobStatus, JobReturn, JobData, JobTask } from './jobmanager.js'

interface Settings {
    disk_base_dir: string;
    cleanup_interval: number;
    cleanup_capacity: number;
    enable_ml: boolean;
    mlModel: string;
    mlFramesPath: string;
    labels: string;
}
interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number;
    lhs_seg_duration_seq?: number;
    seconds: number;
    consecutivesecondswithout: number;
    mlProcessing?: boolean;
    ml?: MLData;
    ml_movejpg?: SpawnData;
}

interface MovementToClient {
    key: number;
    movement: MovementEntry;
    startDate_en_GB: string;
}

interface SpawnData {
    taskid?: SpawnData;
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
    error: string;
}
interface MLTag {
    tag: string;
    maxProbability: number;
    count: number;
}

interface MLData extends SpawnData {
    tags: MLTag[];
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
    secWithoutMovement: number;
    secMaxSingleMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    ignore_tags: string[];
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
    fn_not_finnished : boolean;
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

// Detection accumulator: Maps movement_key to accumulated detections
interface DetectionAccumulator {
    [movement_key: number]: {
        [objectType: string]: { maxProbability: number; count: number };
    };
}
var detectionAccumulator: DetectionAccumulator = {};

// Track which movement_key is associated with each image being processed
var imageToMovementMap: Map<string, number> = new Map();

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


import { ChildProcessWithoutNullStreams, spawn} from 'child_process'
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

const re = new RegExp(`stream([\\d]+).ts`, 'g');

// Function to send image path to ML detection process
function sendImageToMLDetection(imagePath: string, movement_key: number): void {
    if (mlDetectionProcess && mlDetectionProcess.stdin && !mlDetectionProcess.killed) {
        try {
            // Track which movement this image belongs to
            imageToMovementMap.set(imagePath, movement_key);
            mlDetectionProcess.stdin.write(`${imagePath}\n`);
            logger.debug('Image path written to ML stdin', { imagePath, movement: movement_key });
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

// Function to parse detection output and accumulate results
function processDetectionResult(line: string): void {
    // Parse format: "person @ (392 72 552 391) 0.648"
    const match = line.match(/^(\w+)\s+@\s+\([\d\s]+\)\s+([\d.]+)$/);
    if (!match) return;
    
    const objectType = match[1];
    const probability = parseFloat(match[2]);
    
    // Find the movement_key from the most recent image path
    // Since we can't directly correlate output to input, we use the most recent movement
    const recentMovementKeys = Array.from(imageToMovementMap.values());
    if (recentMovementKeys.length === 0) return;
    
    const movement_key = recentMovementKeys[recentMovementKeys.length - 1];
    
    // Initialize accumulator for this movement if needed
    if (!detectionAccumulator[movement_key]) {
        detectionAccumulator[movement_key] = {};
    }
    
    // Update accumulator with max probability
    const current = detectionAccumulator[movement_key][objectType];
    if (!current || probability > current.maxProbability) {
        detectionAccumulator[movement_key][objectType] = {
            maxProbability: probability,
            count: current ? current.count + 1 : 1
        };
    } else {
        current.count++;
    }
}

// Function to flush detection results to database
async function flushDetectionsToDatabase(movement_key: number): Promise<void> {
    const detections = detectionAccumulator[movement_key];
    if (!detections || Object.keys(detections).length === 0) {
        logger.debug('No detections to flush', { movement: movement_key });
        return;
    }
    
    try {
        const movement: MovementEntry = await movementdb.get(movement_key);
        
        // Convert accumulator to MLTag array
        const tags: MLTag[] = Object.entries(detections).map(([tag, data]) => ({
            tag,
            maxProbability: data.maxProbability,
            count: data.count
        })).sort((a, b) => b.maxProbability - a.maxProbability); // Sort by probability descending
        
        // Update movement with detection results
        await movementdb.put(movement_key, {
            ...movement,
            mlProcessing: false,
            ml: {
                success: true,
                code: 0,
                stdout: '',
                stderr: '',
                error: '',
                tags
            }
        });
        
        logger.info('ML results saved', { 
            movement: movement_key, 
            objectTypes: tags.length,
            detections: tags.map(t => ({ tag: t.tag, probability: `${(t.maxProbability*100).toFixed(1)}%`, count: t.count }))
        });
        
        // Clean up accumulator
        delete detectionAccumulator[movement_key];
        
        // Clean up old image mappings for this movement
        for (const [imagePath, mvKey] of imageToMovementMap.entries()) {
            if (mvKey === movement_key) {
                imageToMovementMap.delete(imagePath);
            }
        }
    } catch (error) {
        logger.warn('Failed to flush detections', { movement: movement_key, error: String(error) });
    }
}

 // Called every seond for each camera, to process movement

async function processMovement(cameraKey: string) : Promise<void> {

    const { movementStatus, cameraEntry } = cameraCache[cameraKey]

    // --------- Circuit breaker
    // curcuit breaker, if movement error recorded from API, dont try again, until after check_after!
    const control = { fn_not_finnished: false, fail: false, check_after: 0 }
    const { fn_not_finnished, fail, check_after } = movementStatus?.control || control
    
    // Check and set the flag atomically - if already running, exit immediately
    if (fn_not_finnished  || (fail && ( (!check_after) || check_after > Date.now())) ) {
            logger.debug('processMovement skipped - already in progress or in failure backoff', { camera: cameraEntry.name, cameraKey, fn_not_finnished, fail });
            return
    }
    
    // Set flag to prevent concurrent execution
    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, control: { fail, check_after, fn_not_finnished : true}}}
    logger.debug('processMovement started', { camera: cameraEntry.name, cameraKey });
    // ---------- end Circuit breaker


    const {ip, passwd, disk, folder, secWithoutMovement, secMaxSingleMovement} = cameraEntry
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
        
        logger.info('Fetch completed successfully', { 
            camera: cameraEntry.name, 
            duration: `${fetchDuration}ms`, 
            movementDetected: movementState === 1,
            state: movementState
        });
        
        logger.debug('Response body received', { 
            camera: cameraEntry.name, 
            bodyLength: body_json.length,
            bodyPreview: body_json.substring(0, 100)
        });
        //console.log(body[0].value)
        if (body[0].error) {
            logger.error('Camera API error', { camera: cameraEntry.name, error: body[0].error });
            cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: `fetch movement error: ${JSON.stringify(body)}`, control: {fail: true, fn_not_finnished : false, check_after: Date.now() + (30 * 1000)}}}
        } else if (body[0].value.state === 1) {
            // Got movement (state ===1)
            if (!current_key) {
                // got NEW movement
                logger.info('Movement detected', { camera: cameraEntry.name, type: 'movement_start' })

                // Need to determine the segment that corrisponds to the movement
                // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${disk}/${folder}/stream.m3u8`
                const hls = (await fs.readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")

                const startDate = Date.now(),
                      movement_key = (startDate / 1000 | 0) - 1600000000,
                      startSegment = parseInt(hls_segments[hls_segments.length - 1]) + 1

                // Determine frame output path
                const framesPath = settingsCache.settings.mlFramesPath || `${disk}/${folder}`;
                await ensureDir(framesPath);

                const ffmpegArgs = [
                    '-hide_banner', '-loglevel', 'error',
                    '-i', filepath,
                    '-vf', 'fps=1/2,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2',
                    `${framesPath}/mov${movement_key}_%04d.jpg`
                ];

                logger.info('Starting ffmpeg for frame extraction', {
                    camera: cameraEntry.name,
                    movement: movement_key,
                    framesPath,
                    inputFile: filepath,
                    mlEnabled: settingsCache.settings.enable_ml
                });

                // START FFMPEG!
                var ffmpeg = spawn('/usr/bin/ffmpeg', ffmpegArgs)
                
                let ff_stdout = '', ff_stderr = '', ff_error = ''

                ffmpeg.stdout.on('data', (data: string) => { 
                    logger.debug('ffmpeg image stdout', { camera: cameraEntry.name, data: data.toString() });
                    ff_stdout += data
                 })
                ffmpeg.stderr.on('data', (data: string) => { 
                    logger.warn('ffmpeg image stderr', { camera: cameraEntry.name, data: data.toString() });
                    ff_stderr += data 
                })
                ffmpeg.on('error', async (error: Error) => { 
                    logger.error('ffmpeg image error', { camera: cameraEntry.name, error: error.message });
                    ff_error = `${error.name}: ${error.message}` 
                })

                // Monitor for new JPG files and send them to ML detection immediately
                let lastImageCount = 0;
                const imageMonitor = setInterval(async () => {
                    if (settingsCache.settings.enable_ml && mlDetectionProcess) {
                        try {
                            const files = await fs.readdir(framesPath);
                            const movImages = files.filter(f => f.startsWith(`mov${movement_key}_`) && f.endsWith('.jpg')).sort();
                            
                            logger.debug('Frame monitor check', {
                                camera: cameraEntry.name,
                                movement: movement_key,
                                totalImages: movImages.length,
                                newImages: movImages.length - lastImageCount,
                                mlProcessRunning: mlDetectionProcess !== null && !mlDetectionProcess.killed
                            });
                            
                            // Send only new images since last check
                            for (let i = lastImageCount; i < movImages.length; i++) {
                                const fullImagePath = `${framesPath}/${movImages[i]}`;
                                logger.debug('Frame sent to ML', { frame: movImages[i], movement: movement_key });
                                sendImageToMLDetection(fullImagePath, movement_key);
                            }
                            lastImageCount = movImages.length;
                        } catch (error) {
                            logger.warn('Failed to monitor images', { movement: movement_key, error: String(error) });
                        }
                    } else {
                        logger.debug('Frame monitor check skipped', {
                            camera: cameraEntry.name,
                            mlEnabled: settingsCache.settings.enable_ml,
                            mlProcessRunning: mlDetectionProcess !== null && !mlDetectionProcess?.killed
                        });
                    }
                }, 2000); // Check every 2 seconds for new images

                ffmpeg.on('close', async (ff_code: number) => {
                    logger.info('ffmpeg image closed', { camera: cameraEntry.name, code: ff_code, stdout: ff_stdout.slice(-200), stderr: ff_stderr.slice(-200), error: ff_error });
                    
                    // Stop monitoring for new images
                    clearInterval(imageMonitor);
                    
                    // Send any remaining images to ML detection
                    if (settingsCache.settings.enable_ml && mlDetectionProcess) {
                        try {
                            const files = await fs.readdir(framesPath);
                            const movImages = files.filter(f => f.startsWith(`mov${movement_key}_`) && f.endsWith('.jpg')).sort();
                            
                            // Send any remaining images
                            for (let i = lastImageCount; i < movImages.length; i++) {
                                const fullImagePath = `${framesPath}/${movImages[i]}`;
                                logger.debug('Final frame sent to ML', { frame: movImages[i], movement: movement_key });
                                sendImageToMLDetection(fullImagePath, movement_key);
                            }
                            
                            // Wait a bit for detections to complete, then flush to database
                            setTimeout(async () => {
                                await flushDetectionsToDatabase(movement_key);
                            }, 3000); // Wait 3 seconds for remaining detections
                        } catch (error) {
                            logger.warn('Failed to process final ML detection', { movement: movement_key, error: String(error) });
                        }
                    }
                });

                await movementdb.put(movement_key, {
                    cameraKey,
                    startDate,
                    startSegment,
                    lhs_seg_duration_seq,
                    seconds: 0, // Will be calculated from elapsed time
                    consecutivesecondswithout: 0,
                    mlProcessing: settingsCache.settings.enable_ml
                })

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {current_key: movement_key, current_taskid: ffmpeg, status: "New movement detected", control: {...control, fn_not_finnished: false}}}

            } else {
                // continuatation of same movment event
                const m: MovementEntry = await movementdb.get(current_key)
                
                // Calculate actual elapsed time in seconds
                const elapsedSeconds = Math.floor((Date.now() - m.startDate) / 1000);

                if (elapsedSeconds > (secMaxSingleMovement || 600)) {
                    logger.info('Movement ended - max duration', { camera: cameraEntry.name, duration: `${secMaxSingleMovement}s` })
                    current_taskid?.kill() // kill the ffmpeg process, so it stops writing images
                    
                    // Flush ML detections if enabled
                    if (settingsCache.settings.enable_ml) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finnished: false}}}
                    
                } else {
                    logger.debug('Movement continuation', { camera: cameraEntry.name, duration: `${elapsedSeconds}s` });
                    await movementdb.put(current_key, {...m, seconds: elapsedSeconds, consecutivesecondswithout: 0})
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "Movement Continuation", control: {...control, fn_not_finnished: false}}}
                }

            }
        } else {
            // no movement from camera
            if (current_key) {
                // got current movement
                const m: MovementEntry = await movementdb.get(current_key)
                
                // Calculate actual elapsed time and time since last movement
                const elapsedSeconds = Math.floor((Date.now() - m.startDate) / 1000);
                const timeSinceLastMovement = elapsedSeconds - m.seconds;
                
                if (timeSinceLastMovement > secWithoutMovement || elapsedSeconds > (secMaxSingleMovement || 600)) {

                    logger.info('Movement complete', { camera: cameraEntry.name, duration: `${elapsedSeconds}s` })
                    current_taskid?.kill() // kill the ffmpeg process, so it stops writing images
                    
                    // Flush ML detections if enabled
                    if (settingsCache.settings.enable_ml) {
                        setTimeout(async () => {
                            await flushDetectionsToDatabase(current_key);
                        }, 3000);
                    }
                    
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {current_key: null, status: `Movement ended, recorded to database key=${current_key}`, control: {...control, fn_not_finnished: false}}}
                    

                } else {
                    // still same movement, update elapsed time and time since last movement
                    await movementdb.put(current_key, {...m, seconds: elapsedSeconds, consecutivesecondswithout: timeSinceLastMovement})
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "Movement Continuation (withoutmovement)", control: {...control, fn_not_finnished: false}}}
                }
            } else {
                // no current movement, camera is not reporting movement
                cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...movementStatus, status: "No current movement", control: {...control, fn_not_finnished: false}}}
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
            fn_not_finnished : false,
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
    task: ChildProcessWithoutNullStreams): Promise<ChildProcessWithoutNullStreams | undefined> {
    
    //console.log (`processController for [${name}], called with [pid=${task?.pid}] [exit code=${task?.exitCode}]`)

    // Protects duplicate running if this function takes longer than 1 second
    if (processController_inprogress[name]?.inprogress) {
        logger.debug('processController already in progress', { name });
        return task
    }
    processController_inprogress[name] = {...processController_inprogress[name], inprogress: true}


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

        logger.info('Starting process', { name, cmd, args: cmdArgs.slice(0, 3) + '...', cwd: process.env['PWD'] });
        var childProcess : ChildProcessWithoutNullStreams = spawn(cmd, cmdArgs, {
            cwd: process.env['PWD'] || '/home/kehowli/projects/open-source-nvr'
        })

        let stdoutBuffer = '';
        let stderrBuffer = '';

        childProcess.stdout.on('data', (data: string) => {
            stdoutBuffer += data;
            logger.debug('Process stdout', { name, data: data.toString().trim() });
        })
        childProcess.stderr.on('data', (data: string) => {
            stderrBuffer += data;
            logger.warn('Process stderr', { name, data: data.toString().trim() });
        })
        childProcess.on('error', async (error: Error) => { 
            logger.error('Process error', { name, error: error.message });
       })

        childProcess.on('close', async (code: number) => {
            if (code !== 0) {
                logger.error('Process exited', { 
                    name, 
                    code, 
                    stderr: stderrBuffer.slice(-500),  // Last 500 chars of stderr
                    stdout: stdoutBuffer.slice(-200)   // Last 200 chars of stdout
                });
            } else {
                logger.info('Process closed normally', { name, code });
            }
        });
  
        // sleep for 5 second to allow ffmpeg to start
        await new Promise((res) => setTimeout(res, 4000))
        processController_inprogress[name] = {...processController_inprogress[name], inprogress: false }
        return childProcess

    } catch (e) {
        logger.error('processController error', { name, error: String(e) });
        processController_inprogress[name] = {...processController_inprogress[name], inprogress: false }
        return childProcess
    }


}


const PORT = process.env['PORT'] || 8080


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
                const serve = `${c.disk}/${c.folder}/${m.ml && m.ml.success ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await fs.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
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

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
` + [...Array(Math.round(secondsInt / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"
    
                    ctx.set('content-type', 'application/x-mpegURL')
                    ctx.body = body
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/${file}`
                //console.log(`serving : ${serve}`)
                try {
                    const { size } = await fs.stat(serve)
                    ctx.set('content-type', 'video/MP2T')
                    ctx.body = createReadStream(serve).on('error', ctx.onerror)
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `message=${err.message}`)
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

                await new Promise(async (res, rej) => {
                    const mv_task = spawn('/usr/bin/ffmpeg', ['-y', '-i', `http://localhost:${PORT}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${preseq > 0 || postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve], { timeout: 50000 })
                    let stdout = '', stderr = '', myerror = ''
                    mv_task.stdout.on('data', (data: string) => { stdout += data })
                    mv_task.stderr.on('data', (data: string) => { stderr += data })
                    mv_task.on('error', async (error: Error) => { myerror = `${error.name}: ${error.message}` })

                    mv_task.on('close', async (code: number) => {
                        if (code === 0) {
                            res(0)
                        } else {
                            rej(new Error(`ffmpeg stderr=${stderr} error=${myerror}`))
                        }
                    })
                })

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
                        const new_key = "C" + ((Date.now() / 1000 | 0) - 1600000000)
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

                        // stop old camera definition movements and ffmpeg
                        //if (old_cc.ffmpeg_task.exitCode) {
                        cameraCache[cameraKey] = { 
                            ...cameraCache[cameraKey],
                            cameraEntry: {...old_cc.cameraEntry, enable_streaming: false},
                        }
                        // kill the ffmpeg process if its running
                        await processController ( old_cc.cameraEntry.name,false, null,  [], [0,''], old_cc.ffmpeg_task )
                        
                        // Wait for process to fully terminate before updating
                        await new Promise(resolve => setTimeout(resolve, 1000));


                        if (!deleteOption) {
                            const new_vals: CameraEntry = {...old_cc.cameraEntry, ...new_ce}
                            await cameradb.put(cameraKey, new_vals) 
                            cameraCache[cameraKey] = { cameraEntry: new_vals }
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
          
        }).get('/ml-models', async (ctx, _next) => {
            // Discover available ML models in ai/model directory
            try {
                const modelDir = './ai/model';
                const files = await fs.readdir(modelDir);
                const models = files.filter(f => f.endsWith('.onnx') || f.endsWith('.rknn'));
                ctx.response.set("content-type", "application/json");
                ctx.body = { models };
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(500, `Failed to list ML models: ${err.message}`);
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
                                    seconds: segs.seconds,
                                    consecutivesecondswithout: 0
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
                            const { ml, cameraKey } = value

                            let tags = ml?.success ? ml.tags : null
                            if (mode === 'Filtered') {
                                if (tags && Array.isArray(tags) && tags.length > 0) {
                                    const { ignore_tags } = cameraCache[cameraKey]?.cameraEntry || {}
                                    if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
                                        tags = tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
                                    } 
                                }
                            }
                            if (mode === 'Movement' || (mode === 'Filtered' && tags?.length >0)) {
                                const startDate = new Date(value.startDate)
                                movements.push({
                                    key,
                                    startDate_en_GB: new Intl.DateTimeFormat('en-GB', { ...(startDate.toDateString() !== (new Date()).toDateString() && {weekday: "short"}), minute: "2-digit", hour: "2-digit",  hour12: true }).format(startDate),
                                    movement: {...value, ...(tags &&  { ml: { ...value.ml, tags}})}
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
    const diskres = await diskCheck(diskDir, cameraKeys.map(key => `${diskDir}/${cameraCache[key].cameraEntry.folder}`), cleanupCapacity)
    logger.info('Disk check complete', diskres);
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce((acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs ? (  diskres.folderStats[cur].lastRemovedctimeMs > acc? diskres.folderStats[cur].lastRemovedctimeMs : acc ) : acc ,0)
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            const keytoDeleteTo =  cleanupCapacity === -1 ? null : (mostRecentctimMs / 1000 | 0) - 1600000000
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
                await movementdb.batch([...deleteKeys.map(k => { return {type: 'del', key: k} })] as any)
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
    settingsCache = {settings: { disk_base_dir: '', mlModel:'', mlFramesPath:'', enable_ml: false, labels: defaultLabels, cleanup_interval: 0, cleanup_capacity: 90}, status: { fail: false, nextCheckInMinutes: 0}}
    try {
        settingsCache = {...settingsCache, settings : await db.get('settings') as Settings}
    } catch (e) {
        logger.warn('No settings defined yet');
    }

    // Start the Camera controll loop (ensuring ffmpeg is running, and checking movement) ()
    setInterval(async () => {
        // Start ML detection process if enabled
        const { settings } = settingsCache;
        if (settings.enable_ml && settings.mlModel) {
            const modelPath = `./ai/model/${settings.mlModel}`;
            
            const mlTask = await processController(
                'ML-Detection',
                true,
                'python3',
                ['-u', '-m', 'detector.detect', '--model_path', modelPath],
                [0, ''], // No file check for ML process
                mlDetectionProcess
            );
            
            // Set up stdout handler if this is a new process
            if (mlTask && mlTask !== mlDetectionProcess) {
                mlDetectionProcess = mlTask;
                logger.info('ML detection process started', { 
                    pid: mlTask.pid,
                    model: settings.mlModel 
                });
                
                mlTask.stdout.on('data', (data: string) => {
                    const lines = data.toString().split('\n').filter(line => line.trim());
                    logger.debug('ML detection stdout', { 
                        lineCount: lines.length,
                        lines: lines 
                    });
                    
                    for (const line of lines) {
                        if (line.includes('@')) {
                            logger.info('ML detection', { result: line });
                            processDetectionResult(line);
                        } else {
                            logger.debug('ML detection output (no @ symbol)', { line });
                        }
                    }
                });
                
                mlTask.stderr.on('data', (data: string) => {
                    logger.warn('ML detection stderr', { 
                        output: data.toString()
                    });
                });
                
                mlTask.on('close', (code: number) => {
                    logger.error('ML detection process exited', { 
                        code,
                        model: settings.mlModel
                    });
                    mlDetectionProcess = null;
                });
            } else if (mlTask) {
                mlDetectionProcess = mlTask;
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
                    ['-rtsp_transport', 'tcp', '-i', `rtsp://admin:${cameraEntry.passwd}@${cameraEntry.ip}:554/h264Preview_01_main`, '-hide_banner', '-loglevel', 'error', '-vcodec', 'copy', '-start_number', ((Date.now() / 1000 | 0) - 1600000000).toString(), streamFile ],
                    [ 60, streamFile ],
                    ffmpeg_task
                )
                //console.log (`got task for [${cKey}] [pid=${task?.pid}] [exit code=${task?.exitCode}]`)
                cameraCache[cKey] =  {...cameraCache[cKey], ffmpeg_task: task }
                    
                // Process movement detection if streaming is active and movement detection is enabled
                if (cameraEntry.enable_movement && cameraCache[cKey].ffmpeg_task && cameraCache[cKey].ffmpeg_task.exitCode === null) {
                    // Check if enough time has passed since last movement check
                    const now = Date.now();
                    const lastCheck = cameraCache[cKey].lastMovementCheck || 0;
                    const pollInterval = cameraEntry.mSPollFrequency || 1000; // Default 1 second if not set
                    
                    if (now - lastCheck >= pollInterval) {
                        cameraCache[cKey] = {...cameraCache[cKey], lastMovementCheck: now};
                        await processMovement(cKey);
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

    //db.close()
}

main()
