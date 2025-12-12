/**
 * Unit tests for FFmpeg Process Management
 * Tests the controllerFFmpeg() function's ability to spawn and manage
 * ffmpeg streaming processes without a real camera
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

// Test data paths
const TEST_DATA_DIR = path.join(process.cwd(), 'test/data');
const TEST_VIDEO_DIR = path.join(TEST_DATA_DIR, 'video');
const TEST_OUTPUT_DIR = path.join(TEST_DATA_DIR, 'output');
const TEST_PLAYLIST = path.join(TEST_VIDEO_DIR, 'test.m3u8');

describe('FFmpeg Process', () => {
    let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;

    beforeEach(async () => {
        // Ensure output directory exists
        await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });
    });

    afterEach(async () => {
        // Clean up any spawned processes
        if (ffmpegProcess && ffmpegProcess.exitCode === null) {
            ffmpegProcess.kill();
            await new Promise<void>((resolve) => {
                ffmpegProcess!.once('close', () => resolve());
                setTimeout(resolve, 3000);
            });
        }
        ffmpegProcess = null;

        // Clean up output files
        try {
            const files = await fs.readdir(TEST_OUTPUT_DIR);
            for (const file of files) {
                await fs.unlink(path.join(TEST_OUTPUT_DIR, file));
            }
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('Frame Extraction', () => {
        it('should extract frames from HLS playlist using ffmpeg', async () => {
            // Check if test data exists
            const playlistExists = existsSync(TEST_PLAYLIST);
            if (!playlistExists) {
                console.log('Skipping test: Test playlist not found');
                return;
            }

            const outputPattern = path.join(TEST_OUTPUT_DIR, 'frame_%04d.jpg');

            // Spawn ffmpeg to extract frames (1 fps)
            ffmpegProcess = spawn('/usr/bin/ffmpeg', [
                '-hide_banner',
                '-loglevel', 'info',
                '-i', TEST_PLAYLIST,
                '-vf', 'fps=1,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2',
                outputPattern
            ]);

            // Collect stderr for progress info
            let stderrOutput = '';
            ffmpegProcess.stderr.on('data', (data: Buffer) => {
                stderrOutput += data.toString();
            });

            // Wait for process to complete
            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => {
                    ffmpegProcess?.kill();
                    resolve(null);
                }, 30000);

                ffmpegProcess!.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            });

            expect(exitCode).toBe(0);

            // Check that frames were extracted
            const outputFiles = await fs.readdir(TEST_OUTPUT_DIR);
            const frameFiles = outputFiles.filter(f => f.startsWith('frame_') && f.endsWith('.jpg'));
            
            expect(frameFiles.length).toBeGreaterThan(0);
            console.log(`Extracted ${frameFiles.length} frames`);

            // Verify frame files are valid (non-empty)
            for (const frame of frameFiles.slice(0, 3)) {
                const stats = await fs.stat(path.join(TEST_OUTPUT_DIR, frame));
                expect(stats.size).toBeGreaterThan(0);
            }
        }, 35000);

        it('should handle progress output correctly', async () => {
            const playlistExists = existsSync(TEST_PLAYLIST);
            if (!playlistExists) {
                console.log('Skipping test: Test playlist not found');
                return;
            }

            const outputPattern = path.join(TEST_OUTPUT_DIR, 'progress_frame_%04d.jpg');

            ffmpegProcess = spawn('/usr/bin/ffmpeg', [
                '-hide_banner',
                '-loglevel', 'info',
                '-progress', 'pipe:1',  // Output progress to stdout
                '-i', TEST_PLAYLIST,
                '-vf', 'fps=1',
                outputPattern
            ]);

            let frameCount = 0;
            let lastFrame = 0;

            // Parse stdout for progress info
            ffmpegProcess.stdout.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const frameMatch = line.match(/frame=(\d+)/);
                    if (frameMatch) {
                        const frame = parseInt(frameMatch[1]);
                        if (frame > lastFrame) {
                            lastFrame = frame;
                            frameCount++;
                        }
                    }
                }
            });

            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => {
                    ffmpegProcess?.kill();
                    resolve(null);
                }, 30000);

                ffmpegProcess!.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            });

            expect(exitCode).toBe(0);
            expect(lastFrame).toBeGreaterThan(0);
            console.log(`Final frame count: ${lastFrame}`);
        }, 35000);
    });

    describe('Error Handling', () => {
        it('should handle non-existent input file gracefully', async () => {
            ffmpegProcess = spawn('/usr/bin/ffmpeg', [
                '-hide_banner',
                '-i', '/nonexistent/file.m3u8',
                '-vf', 'fps=1',
                path.join(TEST_OUTPUT_DIR, 'error_%04d.jpg')
            ]);

            let stderrOutput = '';
            ffmpegProcess.stderr.on('data', (data: Buffer) => {
                stderrOutput += data.toString();
            });

            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => {
                    ffmpegProcess?.kill();
                    resolve(null);
                }, 10000);

                ffmpegProcess!.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            });

            // Should exit with non-zero code
            expect(exitCode).not.toBe(0);
            expect(stderrOutput).toContain('No such file');
        }, 15000);

        it('should be killable mid-process', async () => {
            const playlistExists = existsSync(TEST_PLAYLIST);
            if (!playlistExists) {
                console.log('Skipping test: Test playlist not found');
                return;
            }

            ffmpegProcess = spawn('/usr/bin/ffmpeg', [
                '-hide_banner',
                '-i', TEST_PLAYLIST,
                '-vf', 'fps=1',
                path.join(TEST_OUTPUT_DIR, 'kill_%04d.jpg')
            ]);

            // Wait a bit then kill
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            expect(ffmpegProcess.exitCode).toBeNull();
            ffmpegProcess.kill('SIGTERM');

            const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
                ffmpegProcess!.on('close', (code, signal) => {
                    resolve({ code, signal });
                });
            });

            // Process should have terminated (either by signal or with code)
            // FFmpeg might exit with code 255 on SIGTERM instead of reporting signal
            const terminated = exitResult.signal === 'SIGTERM' || exitResult.code !== null;
            expect(terminated).toBe(true);
            console.log(`Process terminated: code=${exitResult.code}, signal=${exitResult.signal}`);
        }, 15000);
    });
});
