/**
 * Test Database Helper
 * 
 * Creates isolated in-memory databases for testing with
 * proper configuration of cameras and settings.
 */

import { Level } from 'level';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { CameraEntry, MovementEntry, Settings } from '../../server/www.js';

export interface TestDatabases {
    /** Base Level instance */
    db: Level<string, any>;
    /** Settings sublevel */
    settingsdb: any;
    /** Camera sublevel */
    cameradb: any;
    /** Movement sublevel */
    movementdb: any;
    /** Path to temp database directory */
    dbPath: string;
    /** Clean up databases and temp files */
    cleanup: () => Promise<void>;
}

/**
 * Creates isolated test databases in a temp directory
 */
export async function createTestDatabases(): Promise<TestDatabases> {
    const dbPath = path.join(os.tmpdir(), `nvr-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dbPath, { recursive: true });

    const db = new Level(dbPath, { valueEncoding: 'json' });
    const settingsdb = db.sublevel<string, Settings>('settings', { valueEncoding: 'json' });
    const cameradb = db.sublevel<string, CameraEntry>('camera', { valueEncoding: 'json' });
    const movementdb = db.sublevel<string, MovementEntry>('movement', { valueEncoding: 'json' });

    return {
        db,
        settingsdb,
        cameradb,
        movementdb,
        dbPath,
        cleanup: async () => {
            await db.close();
            await fs.rm(dbPath, { recursive: true, force: true });
        }
    };
}

/**
 * Default test settings - matches Settings interface from www.ts
 */
export function createTestSettings(overrides?: Partial<Settings>): Settings {
    return {
        disk_base_dir: '/tmp/nvr-test',
        disk_cleanup_interval: 60,
        disk_cleanup_capacity: 80,
        detection_enable: false,
        detection_model: '',
        detection_target_hw: 'cpu',
        detection_frames_path: 'frames',
        detection_tag_filters: [],
        ...overrides
    };
}

/**
 * Creates a test camera entry with sensible defaults
 */
export function createTestCamera(overrides?: Partial<CameraEntry>): CameraEntry {
    return {
        delete: false,
        name: 'Test Camera',
        folder: 'test-camera',
        disk: '/tmp/nvr-test',
        enable_streaming: false,
        enable_movement: true,
        pollsWithoutMovement: 3,
        secMaxSingleMovement: 300,
        mSPollFrequency: 1000,
        segments_prior_to_movement: 2,
        segments_post_movement: 2,
        secMovementStartupDelay: 0,
        ...overrides
    };
}
