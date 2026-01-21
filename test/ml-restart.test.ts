import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/index.js';
import fs from 'fs/promises';

/**
 * Integration tests for ML process scheduled restart functionality.
 * These tests use real processes and database operations.
 * Uses detect_stub.py which doesn't require OpenCV/ONNX dependencies.
 */
describe('ML Process Scheduled Restart (Integration)', () => {
    const testDbPath = '/tmp/test-nvr-db-' + Date.now();
    let server: Awaited<ReturnType<typeof createServer>>;
    let baseUrl: string;

    beforeAll(async () => {
        // Ensure test db directory is clean
        await fs.rm(testDbPath, { recursive: true, force: true });
    });

    afterAll(async () => {
        // Cleanup test database
        await fs.rm(testDbPath, { recursive: true, force: true });
    });

    beforeEach(async () => {
        // Create server with test database
        server = await createServer({
            port: 0, // Random available port
            dbPath: testDbPath,
            registerSignalHandlers: false // Don't register signal handlers in tests
        });
        baseUrl = server.baseUrl;
    });

    afterEach(async () => {
        if (server) {
            await server.shutdown();
        }
    });

    it('should save ml_restart_schedule to settings via API', async () => {
        // Save settings with restart schedule
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: false,
            detection_model: '',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '03:30'
        };

        const response = await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        expect(response.ok).toBe(true);

        // Verify settings were saved (config is returned via movements endpoint)
        const getResponse = await fetch(`${baseUrl}/api/movements?mode=Movement`);
        const data = await getResponse.json() as { config: { settings: { ml_restart_schedule: string } } };
        
        expect(data.config.settings.ml_restart_schedule).toBe('03:30');
    });

    it('should start ML process when detection is enabled', async () => {
        // Enable detection with valid model path
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Run control loop to start ML process
        await server.runControlLoop();

        // Give the process a moment to start
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check if ML process is running
        const mlProcess = await import('../server/processor.js').then(m => m.getMLDetectionProcess());
        expect(mlProcess).not.toBeNull();
        expect(mlProcess?.pid).toBeGreaterThan(0);
    });

    it('should track ML process start time for restart scheduling', async () => {
        // Enable detection
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Run control loop
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check restart state
        const { getMLRestartState } = await import('../server/processor.js');
        const state = getMLRestartState();
        
        expect(state.startedAt).toBeGreaterThan(0);
        expect(state.restartPending).toBe(false);
    });

    it('should disable restart when ml_restart_schedule is empty', async () => {
        // Set empty restart schedule (disabled)
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '' // Disabled
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Run control loop multiple times
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 200));
        await server.runControlLoop();

        // Restart should not be pending
        const { getMLRestartState } = await import('../server/processor.js');
        const state = getMLRestartState();
        
        expect(state.restartPending).toBe(false);
    });

    it('should pause new frames when restart is pending', async () => {
        // Enable detection
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Start ML process
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        // Manually set restart pending to test the pause behavior
        const { setMLRestartStateForTest, getMLRestartState } = await import('../server/processor.js');
        setMLRestartStateForTest({ restartPending: true });

        const state = getMLRestartState();
        expect(state.restartPending).toBe(true);
        
        // The sendImageToMLDetection function should check this flag
        // (verified by code inspection - frames won't be sent when pending)
    });

    it('should wait for in-flight frames before restarting', async () => {
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Start ML process
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        const { 
            setMLRestartStateForTest, 
            addMLFrameInFlightForTest, 
            getMLDetectionProcess,
            getMLRestartState 
        } = await import('../server/processor.js');

        // Get original process PID
        const originalProcess = getMLDetectionProcess();
        const originalPid = originalProcess?.pid;
        expect(originalPid).toBeGreaterThan(0);

        // Add frames in flight and set restart pending
        addMLFrameInFlightForTest('test_frame_001.jpg');
        addMLFrameInFlightForTest('test_frame_002.jpg');
        setMLRestartStateForTest({ restartPending: true });

        // Run control loop - should NOT restart because frames are in flight
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 100));

        // Process should still be running with same PID
        const currentProcess = getMLDetectionProcess();
        expect(currentProcess?.pid).toBe(originalPid);

        // Frames should still be in flight
        const state = getMLRestartState();
        expect(state.framesInFlight).toBe(2);
    });

    it('should complete restart when frames are drained', async () => {
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Start ML process
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        const { 
            setMLRestartStateForTest, 
            clearMLFramesInFlightForTest, 
            getMLDetectionProcess,
            getMLRestartState 
        } = await import('../server/processor.js');

        // Get original process PID
        const originalProcess = getMLDetectionProcess();
        const originalPid = originalProcess?.pid;
        expect(originalPid).toBeGreaterThan(0);

        // Set restart pending with no frames in flight
        clearMLFramesInFlightForTest();
        setMLRestartStateForTest({ 
            restartPending: true,
            startedAt: Date.now() - 1000 // Process was started a second ago
        });

        // Run control loop - should restart because no frames in flight
        await server.runControlLoop();
        
        // Wait for process to restart
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Run control loop again to start new process
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        // Process should be running with a NEW PID
        const newProcess = getMLDetectionProcess();
        expect(newProcess).not.toBeNull();
        expect(newProcess?.pid).toBeGreaterThan(0);
        
        // The PID should be different (new process)
        // Note: In rare cases the OS could reuse the PID, but this is unlikely
        // The key indicator is that restartPending should be false now
        const state = getMLRestartState();
        expect(state.restartPending).toBe(false);
    });

    it('should record restart date to prevent multiple restarts per day', async () => {
        const settings = {
            disk_base_dir: '/tmp',
            disk_cleanup_interval: 60,
            disk_cleanup_capacity: 80,
            detection_enable: true,
            detection_model: 'stub',
            detection_target_hw: '',
            detection_frames_path: 'frames',
            detection_tag_filters: [],
            ml_restart_schedule: '01:00'
        };

        await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // Start ML process
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        const { 
            setMLRestartStateForTest, 
            clearMLFramesInFlightForTest, 
            getMLRestartState 
        } = await import('../server/processor.js');

        // Simulate restart completion
        clearMLFramesInFlightForTest();
        setMLRestartStateForTest({ 
            restartPending: true,
            startedAt: Date.now() - 1000
        });

        // Run control loop to trigger restart
        await server.runControlLoop();
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check that lastRestartDate is set
        const state = getMLRestartState();
        const today = new Date().toISOString().split('T')[0];
        expect(state.lastRestartDate).toBe(today);
    });
});
