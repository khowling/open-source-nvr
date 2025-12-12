/**
 * Utility functions for process management and stream processing
 * Provides a clean pipeline approach for spawning processes and handling their output
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs/promises';

// Helper for encoding movement keys consistently
const encodeMovementKey = (n: number): string => {
    return n.toString().padStart(12, '0');
};

// Forward declaration for logger (will be injected)
let logger: any;

export function setLogger(loggerInstance: any) {
    logger = loggerInstance;
}

// Global process registry to track all spawned processes
const processRegistry = new Set<ChildProcessWithoutNullStreams>();

export function getAllProcesses(): ChildProcessWithoutNullStreams[] {
    return Array.from(processRegistry);
}

// Forward declaration for settings and movementdb (will be injected)
let settingsCache: any;
let movementdb: any;
let sendImageToMLDetection: any;
let isShuttingDown: boolean = false;

export function setDependencies(deps: {
    settingsCache: any;
    movementdb: any;
    sendImageToMLDetection: (path: string, key: number) => void;
    getShuttingDown: () => boolean;
}) {
    settingsCache = deps.settingsCache;
    movementdb = deps.movementdb;
    sendImageToMLDetection = deps.sendImageToMLDetection;
    isShuttingDown = deps.getShuttingDown();
}

export interface ProcessSpawnOptions {
    name: string;
    cmd: string;
    args: string[];
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    onError?: (error: Error) => void;
    onClose?: (code: number | null, signal: string | null) => void;
    captureOutput?: boolean;  // If true, capture stdout/stderr and pass to onClose
    timeout?: number;  // Timeout in milliseconds for spawn operation
}

/**
 * Spawn a process with consistent logging and stream handling
 */
export function spawnProcess(options: ProcessSpawnOptions): ChildProcessWithoutNullStreams {
    const { name, cmd, args, cwd, onStdout, onStderr, onError, onClose, captureOutput, timeout } = options;
    
    logger.info('Spawning process', { name, cmd, args: args.slice(0, 3).join(' ') + '...', cwd: cwd || process.cwd() });
    
    const childProcess = spawn(cmd, args, { 
        cwd: cwd || process.cwd(),
        ...(timeout && { timeout })
    });
    
    // Register process globally for cleanup tracking
    processRegistry.add(childProcess);
    
    let stdoutBuffer = '';
    let stderrBuffer = '';
    
    if (onStdout) {
        childProcess.stdout.on('data', (data: Buffer) => {
            const str = data.toString();
            if (captureOutput) stdoutBuffer += str;
            onStdout(str);
        });
    } else {
        childProcess.stdout.on('data', (data: Buffer) => {
            const str = data.toString();
            stdoutBuffer += str;
            logger.debug('Process stdout', { name, data: str.trim() });
        });
    }
    
    if (onStderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
            const str = data.toString();
            if (captureOutput) stderrBuffer += str;
            onStderr(str);
        });
    } else {
        childProcess.stderr.on('data', (data: Buffer) => {
            const str = data.toString();
            stderrBuffer += str;
            logger.warn('Process stderr', { name, data: str.trim() });
        });
    }
    
    if (onError) {
        childProcess.on('error', onError);
    } else {
        childProcess.on('error', (error: Error) => {
            logger.error('Process error', { name, error: error.message });
        });
    }
    
    if (onClose) {
        childProcess.on('close', (code: number | null, signal: string | null) => {
            // Remove from registry when closed
            processRegistry.delete(childProcess);
            
            if (captureOutput) {
                // Pass captured output via a custom property
                (childProcess as any).__capturedOutput = { stdout: stdoutBuffer, stderr: stderrBuffer };
            }
            onClose(code, signal);
        });
    } else {
        childProcess.on('close', (code: number | null, signal: string | null) => {
            // Remove from registry when closed
            processRegistry.delete(childProcess);
            
            const isGraceful = code === 0 || code === 255 || code === null;
            const logLevel = isGraceful ? 'info' : 'error';
            
            if (!isGraceful && captureOutput) {
                logger[logLevel]('Process closed', { 
                    name, 
                    code, 
                    signal, 
                    graceful: isGraceful,
                    stderr: stderrBuffer.slice(-500),
                    stdout: stdoutBuffer.slice(-200)
                });
            } else {
                logger[logLevel]('Process closed', { name, code, signal, graceful: isGraceful });
            }
        });
    }
    
    logger.info('Process spawned', { name, pid: childProcess.pid });
    return childProcess;
}

/**
 * Helper to run a process to completion and return the result
 * Useful for one-off tasks like video conversion
 */
export async function runProcess(options: Omit<ProcessSpawnOptions, 'onClose'>): Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        
        const childProcess = spawnProcess({
            ...options,
            captureOutput: true,
            onStdout: (data: string) => {
                stdout += data;
                options.onStdout?.(data);
            },
            onStderr: (data: string) => {
                stderr += data;
                options.onStderr?.(data);
            },
            onError: (error: Error) => {
                options.onError?.(error);
                reject(error);
            },
            onClose: (code: number | null, signal: string | null) => {
                resolve({ code, signal, stdout, stderr });
            }
        });
    });
}

export interface StreamVerificationOptions {
    processName: string;
    process: ChildProcessWithoutNullStreams;
    outputFilePath: string;
    maxWaitTimeMs?: number;
    maxFileAgeMs?: number;
    checkIntervalMs?: number;
}

export interface StreamVerificationResult {
    ready: boolean;
    message: string;
    startupTimeMs?: number;
    fileAgeMs?: number;
}

/**
 * Verify that a streaming process has started successfully and is producing output
 * Checks that the process is running and the output file is being updated
 * 
 * @param options Configuration for stream verification
 * @returns Promise that resolves with verification result
 */
export async function verifyStreamStartup(options: StreamVerificationOptions): Promise<StreamVerificationResult> {
    const {
        processName,
        process: childProcess,
        outputFilePath,
        maxWaitTimeMs = 10000,
        maxFileAgeMs = 5000,
        checkIntervalMs = 1000
    } = options;

    const startTime = Date.now();
    
    logger.info('Verifying stream startup', { 
        name: processName, 
        pid: childProcess.pid,
        outputFile: outputFilePath,
        maxWait: `${maxWaitTimeMs}ms`
    });

    while ((Date.now() - startTime) < maxWaitTimeMs) {
        // Check if process is still running
        if (childProcess.exitCode !== null) {
            const result = {
                ready: false,
                message: `Process died during startup (exit code: ${childProcess.exitCode})`,
                startupTimeMs: Date.now() - startTime
            };
            logger.error('Stream verification failed - process died', result);
            return result;
        }
        
        // Check if output file exists and is being updated
        try {
            const stats = await fs.stat(outputFilePath);
            const fileAge = Date.now() - stats.mtimeMs;
            
            if (fileAge < maxFileAgeMs) {
                const result = {
                    ready: true,
                    message: 'Stream verified and ready',
                    startupTimeMs: Date.now() - startTime,
                    fileAgeMs: fileAge
                };
                logger.info('Stream verification successful', {
                    name: processName,
                    ...result
                });
                return result;
            } else {
                logger.debug('Stream file exists but stale', {
                    name: processName,
                    fileAge: `${fileAge}ms`,
                    elapsed: `${Date.now() - startTime}ms`
                });
            }
        } catch (e) {
            // File doesn't exist yet, keep waiting
            logger.debug('Stream file not ready yet', {
                name: processName,
                elapsed: `${Date.now() - startTime}ms`
            });
        }
        
        await new Promise((res) => setTimeout(res, checkIntervalMs));
    }
    
    // Timeout reached
    const result = {
        ready: false,
        message: childProcess.exitCode === null 
            ? 'Timeout waiting for stream, but process still running'
            : `Process exited with code ${childProcess.exitCode}`,
        startupTimeMs: Date.now() - startTime
    };
    
    if (childProcess.exitCode === null) {
        logger.warn('Stream verification timeout', {
            name: processName,
            ...result,
            note: 'Process still running, may become ready later'
        });
    } else {
        logger.error('Stream verification failed', {
            name: processName,
            ...result
        });
    }
    
    return result;
}

/**
 * Check if a stream output file is current (recently updated)
 * Useful for ongoing validation that a stream is still working
 * 
 * @param filePath Path to the stream output file
 * @param maxAgeMs Maximum age in milliseconds (default: 10000ms = 10s)
 * @returns Promise that resolves to true if file exists and is current
 */
export async function isStreamCurrent(filePath: string, maxAgeMs: number = 10000): Promise<boolean> {
    try {
        const stats = await fs.stat(filePath);
        const fileAge = Date.now() - stats.mtimeMs;
        return fileAge < maxAgeMs;
    } catch (e) {
        return false;
    }
}

/**
 * Create a processor for ffmpeg frame extraction output
 * Extracts frame numbers and paths, sends them to ML detection
 */
export function createFFmpegFrameProcessor(movement_key: string, framesPath: string, cameraName: string) {
    let lastFrameNumber = 0;
    let errorMessages: string[] = [];
    
    return {
        processStdout: (data: string) => {
            const lines = data.split('\n');
            logger.debug('ffmpeg stdout', { camera: cameraName, movement: movement_key, lineCount: lines.length });
            
            for (const line of lines) {
                const frameMatch = line.match(/frame=\s*(\d+)/);
                if (frameMatch) {
                    const frameNumber = parseInt(frameMatch[1]);
                    if (frameNumber > lastFrameNumber) {
                        lastFrameNumber = frameNumber;
                        const framePath = `${framesPath}/mov${movement_key}_${frameNumber.toString().padStart(4, '0')}.jpg`;
                        
                        logger.info('createFFmpegFrameProcessor: Frame extracted', { 
                            camera: cameraName, 
                            movement: movement_key, 
                            frame: frameNumber,
                            path: framePath
                        });
                        
                        // Send to ML detection pipeline
                        if (settingsCache.settings.detection_enable) {
                            sendImageToMLDetection(framePath, movement_key);
                        }
                        
                        // Update ML status to 'analyzing' after first frame
                        if (frameNumber === 1) {

                            movementdb.get(movement_key).then((movement: any) => {
                                movementdb.put(movement_key, {
                                    ...movement,
                                    detection_status: 'analyzing'
                                }).catch((err: Error) => {
                                    logger.warn('Failed to update ML status', { movement: movement_key, error: String(err) });
                                });
                            }).catch((err: Error) => {
                                logger.warn('Failed to get movement for ML status update', { movement: movement_key, error: String(err) });
                            });
                        }
                    }
                }
            }
        },
        processStderr: (data: string) => {
            const isProgressInfo = data.includes('frame=') || data.includes('fps=') || data.includes('time=');
            const isInfoMessage = data.includes('Input #0') || data.includes('Output #0') || 
                                 data.includes('Stream mapping:') || data.includes('Duration:') ||
                                 data.includes('Press [q]') || data.includes('Stream #');
            const isHLSNoise = data.includes('[hls @') && (data.includes("Skip ('#EXT-X-VERSION") || data.includes("Opening '"));
            
            if (!isProgressInfo && !isInfoMessage && !isHLSNoise) {
                const trimmed = data.trim();
                errorMessages.push(trimmed);
                logger.warn('createFFmpegFrameProcessor: ffmpeg stderr', { camera: cameraName, movement: movement_key, data: trimmed });
            }
        },
        getLastFrameNumber: () => lastFrameNumber,
        getErrors: () => errorMessages
    };
}

/**
 * Create a processor for ML detection results
 * Parses JSON output and updates movement database
 */
export function createMLResultProcessor(processDetectionResult: (line: string) => Promise<void>) {
    let currentProcessingImage: string | null = null;
    
    return {
        processStdout: async (data: string) => {
            const lines = data.split('\n').filter(line => line.trim());
            
            for (const line of lines) {
                // Check for IMAGE: marker from Python
                if (line.startsWith('IMAGE:')) {
                    const imagePath = line.substring(6).trim();
                    currentProcessingImage = imagePath;
                    logger.debug('ML processing image', { image: imagePath });
                    continue;
                }
                
                // Check for READY marker from Python
                if (line === 'READY') {
                    logger.info('ML detector ready');
                    continue;
                }
                
                // Try to parse as detection result JSON
                try {
                    const result = JSON.parse(line);
                    if (result.image && result.detections) {
                        await processDetectionResult(line);
                    }
                } catch (e) {
                    // Not JSON, could be informational message
                    logger.debug('ML detector info', { message: line });
                }
            }
        },
        processStderr: (data: string) => {
            logger.warn('ML detector stderr', { output: data.toString() });
        }
    };
}
