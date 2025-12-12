/**
 * Unit tests for ML Detection Process Launcher
 * Tests the controllerDetector() function's ability to spawn and manage
 * the Python ML detection process
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

// Test data paths
const TEST_DATA_DIR = path.join(process.cwd(), 'test/data');
const TEST_FRAMES_DIR = path.join(TEST_DATA_DIR, 'frames');
const SAMPLE_FRAME = path.join(TEST_FRAMES_DIR, 'sample_frame.jpg');
const AI_DIR = path.join(process.cwd(), 'ai');

describe('ML Detection Process', () => {
    let mlProcess: ChildProcessWithoutNullStreams | null = null;

    afterEach(async () => {
        // Clean up any spawned processes
        if (mlProcess && mlProcess.exitCode === null) {
            mlProcess.kill();
            await new Promise<void>((resolve) => {
                mlProcess!.once('close', () => resolve());
                setTimeout(resolve, 2000); // Timeout fallback
            });
        }
        mlProcess = null;
    });

    describe('Process Spawning', () => {
        it('should spawn the ML detection process successfully', async () => {
            const modelPath = 'model/yolo11n.onnx';
            
            // Check if model exists
            const modelFullPath = path.join(AI_DIR, modelPath);
            const modelExists = await fs.access(modelFullPath).then(() => true).catch(() => false);
            
            if (!modelExists) {
                console.log(`Skipping test: Model not found at ${modelFullPath}`);
                return;
            }

            mlProcess = spawn('python3', ['-u', '-m', 'detector.detect', '--model_path', modelPath], {
                cwd: AI_DIR
            });

            expect(mlProcess).not.toBeNull();
            expect(mlProcess.pid).toBeDefined();
            expect(typeof mlProcess.pid).toBe('number');

            // Give the process time to start (model loading takes a few seconds)
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Process should still be running (waiting for stdin)
            expect(mlProcess.exitCode).toBeNull();
            console.log('ML process started and waiting for input');
        }, 15000);

        it('should accept image paths via stdin and return detections', async () => {
            const modelPath = 'model/yolo11n.onnx';
            
            // Check prerequisites
            const modelFullPath = path.join(AI_DIR, modelPath);
            const modelExists = await fs.access(modelFullPath).then(() => true).catch(() => false);
            const frameExists = await fs.access(SAMPLE_FRAME).then(() => true).catch(() => false);
            
            if (!modelExists || !frameExists) {
                console.log('Skipping test: Model or sample frame not found');
                return;
            }

            mlProcess = spawn('python3', ['-u', '-m', 'detector.detect', '--model_path', modelPath], {
                cwd: AI_DIR
            });

            // Wait for model to load (it reads from stdin immediately after loading)
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Send image path
            mlProcess.stdin.write(`${SAMPLE_FRAME}\n`);

            // Wait for detection result
            const result = await new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout waiting for detection')), 15000);
                
                mlProcess!.stdout.on('data', (data: Buffer) => {
                    const lines = data.toString().split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.image && parsed.detections !== undefined) {
                                clearTimeout(timeout);
                                resolve(parsed);
                                return;
                            }
                        } catch {
                            // Not JSON, continue
                        }
                    }
                });
            });

            expect(result).toHaveProperty('image');
            expect(result).toHaveProperty('detections');
            expect(Array.isArray(result.detections)).toBe(true);
            
            // Log what was detected
            console.log('Detections:', result.detections.map((d: any) => 
                `${d.object} (${(d.probability * 100).toFixed(1)}%)`
            ).join(', ') || 'none');
        }, 30000);
    });

    describe('Process Error Handling', () => {
        it('should handle invalid model path gracefully', async () => {
            mlProcess = spawn('python3', ['-u', '-m', 'detector.detect', '--model_path', 'nonexistent/model.onnx'], {
                cwd: AI_DIR
            });

            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => {
                    mlProcess?.kill();
                    resolve(null);
                }, 5000);

                mlProcess!.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            });

            // Process should exit with non-zero code
            expect(exitCode).not.toBe(0);
        }, 10000);
    });
});
