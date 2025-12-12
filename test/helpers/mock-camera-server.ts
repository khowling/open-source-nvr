/**
 * Mock Camera Server for Testing
 * 
 * Simulates a camera's motion detection API endpoint.
 * Returns configurable responses for movement state.
 */

import http from 'node:http';

export interface MockCameraState {
    /** 1 = movement detected, 0 = no movement */
    movementState: 0 | 1;
    /** Optional error response */
    error?: { code: number; message: string };
    /** Delay before responding (ms) */
    responseDelay?: number;
    /** Force HTTP error status */
    httpStatus?: number;
}

export interface MockCameraServer {
    /** The URL to use for camera motion API */
    url: string;
    /** The port the server is listening on */
    port: number;
    /** Set the camera state for next response */
    setState: (state: Partial<MockCameraState>) => void;
    /** Get current state */
    getState: () => MockCameraState;
    /** Get count of requests received */
    getRequestCount: () => number;
    /** Reset request count */
    resetRequestCount: () => void;
    /** Stop the server */
    close: () => Promise<void>;
}

/**
 * Creates a mock camera server that simulates the camera motion API
 * 
 * @example
 * const server = await createMockCameraServer();
 * 
 * // Set movement detected
 * server.setState({ movementState: 1 });
 * 
 * // Use server.url in camera config
 * const camera = { motionUrl: server.url, ... };
 * 
 * // Clean up
 * await server.close();
 */
export async function createMockCameraServer(initialState?: Partial<MockCameraState>): Promise<MockCameraServer> {
    let state: MockCameraState = {
        movementState: 0,
        ...initialState
    };
    let requestCount = 0;

    const server = http.createServer(async (req, res) => {
        requestCount++;

        // Simulate response delay if configured
        if (state.responseDelay && state.responseDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, state.responseDelay));
        }

        // Force HTTP error if configured
        if (state.httpStatus && state.httpStatus !== 200) {
            res.writeHead(state.httpStatus, { 'Content-Type': 'text/plain' });
            res.end(`HTTP Error ${state.httpStatus}`);
            return;
        }

        // Return camera-style JSON response
        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (state.error) {
            res.end(JSON.stringify([{ error: state.error }]));
        } else {
            res.end(JSON.stringify([{
                cmd: 'GetMdState',
                code: 0,
                value: {
                    state: state.movementState
                }
            }]));
        }
    });

    // Find available port
    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to get server address');
    }

    const port = address.port;
    const url = `http://127.0.0.1:${port}/api.cgi`;

    return {
        url,
        port,
        setState: (newState: Partial<MockCameraState>) => {
            state = { ...state, ...newState };
        },
        getState: () => ({ ...state }),
        getRequestCount: () => requestCount,
        resetRequestCount: () => { requestCount = 0; },
        close: () => new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        })
    };
}
