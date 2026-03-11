/**
 * Prometheus metrics for NVR server
 * 
 * All metrics use the 'nvr_' prefix. Camera-level metrics use a 'camera' label.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Collect Node.js default metrics (GC, event loop, memory, etc.)
collectDefaultMetrics({ register: registry });

// ============================================================================
// Movement Detection (per-camera motion API polling)
// ============================================================================

export const movementDetectionApiCalls = new Counter({
    name: 'nvr_movement_detection_api_calls_total',
    help: 'Camera motion API poll calls',
    labelNames: ['camera', 'result'] as const,  // result: detected | none | error
    registers: [registry]
});

export const movementsCreated = new Counter({
    name: 'nvr_movements_created_total',
    help: 'New movements detected',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const movementDuration = new Histogram({
    name: 'nvr_movement_duration_seconds',
    help: 'Video duration of finalized movements',
    labelNames: ['camera'] as const,
    buckets: [5, 10, 30, 60, 120, 300, 600],
    registers: [registry]
});

// ============================================================================
// Movement Processing / Object Detection
// ============================================================================

export const movementProcessingDuration = new Histogram({
    name: 'nvr_movement_processing_duration_seconds',
    help: 'Total time from processing start to completion',
    labelNames: ['camera'] as const,
    buckets: [1, 5, 10, 30, 60, 90, 120],
    registers: [registry]
});

export const movementProcessingResult = new Counter({
    name: 'nvr_movement_processing_result_total',
    help: 'Movement processing outcomes',
    labelNames: ['camera', 'result'] as const,  // result: completed | failed | timeout
    registers: [registry]
});

export const movementFramesSent = new Counter({
    name: 'nvr_movement_frames_sent_total',
    help: 'Frames sent to ML detector across all movements',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const movementFramesReceived = new Counter({
    name: 'nvr_movement_frames_received_total',
    help: 'ML detection results received across all movements',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const mlFrameProcessingDuration = new Histogram({
    name: 'nvr_ml_frame_processing_duration_seconds',
    help: 'Per-frame ML inference latency',
    labelNames: ['camera'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry]
});

export const movementDetectionToProcessingLag = new Histogram({
    name: 'nvr_movement_detection_to_processing_lag_seconds',
    help: 'Lag between movement detection and ML processing start',
    labelNames: ['camera'] as const,
    buckets: [1, 2, 5, 10, 30, 60, 120],
    registers: [registry]
});

export const mlObjectsDetected = new Counter({
    name: 'nvr_ml_objects_detected_total',
    help: 'Objects detected by ML model',
    labelNames: ['camera', 'object_class'] as const,
    registers: [registry]
});

// ============================================================================
// ML Detector Health
// ============================================================================

export const mlDetectorRunning = new Gauge({
    name: 'nvr_ml_detector_running',
    help: '1 if ML detector process is alive',
    registers: [registry]
});

export const mlDetectorFramesInFlight = new Gauge({
    name: 'nvr_ml_detector_frames_in_flight',
    help: 'Number of frames sent to ML awaiting results',
    registers: [registry]
});

export const mlDetectorRestarts = new Counter({
    name: 'nvr_ml_detector_restarts_total',
    help: 'ML detector process restarts',
    labelNames: ['reason'] as const,  // reason: scheduled | crash | disabled
    registers: [registry]
});

// ============================================================================
// Disk Cleanup
// ============================================================================

export const diskCleanupFilesDeleted = new Counter({
    name: 'nvr_disk_cleanup_files_deleted_total',
    help: 'Video files deleted by disk cleanup',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const diskCleanupBytesDeleted = new Counter({
    name: 'nvr_disk_cleanup_bytes_deleted_total',
    help: 'Bytes reclaimed by disk cleanup',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const diskCleanupMovementsDeleted = new Counter({
    name: 'nvr_disk_cleanup_movements_deleted_total',
    help: 'Movement records pruned from database by disk cleanup',
    labelNames: ['camera'] as const,
    registers: [registry]
});

export const diskCleanupRuns = new Counter({
    name: 'nvr_disk_cleanup_runs_total',
    help: 'Disk cleanup runs executed',
    registers: [registry]
});

// ============================================================================
// System / Control Loop
// ============================================================================

export const controlLoopDuration = new Histogram({
    name: 'nvr_control_loop_duration_seconds',
    help: 'Control loop iteration time',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [registry]
});

export const activeCameras = new Gauge({
    name: 'nvr_active_cameras',
    help: 'Number of cameras with streaming enabled',
    registers: [registry]
});
