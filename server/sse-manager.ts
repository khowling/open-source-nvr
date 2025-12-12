/**
 * Server-Sent Events (SSE) Manager
 * Manages SSE connections and broadcasts movement updates to connected clients
 */

import { Context } from 'koa';

export interface SSEClient {
    id: string;
    ctx: Context;
    lastEventId?: string;
}

export interface MovementUpdateEvent {
    type: 'movement_new' | 'movement_update' | 'movement_complete';
    movement: any;
}

let logger: any;

export function setLogger(loggerInstance: any) {
    logger = loggerInstance;
}

class SSEManager {
    private clients: Map<string, SSEClient> = new Map();
    private eventId: number = 0;

    /**
     * Register a new SSE client connection
     */
    addClient(ctx: Context): string {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        
        // Set headers for SSE
        ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        
        ctx.status = 200;
        
        // Tell Koa not to handle the response
        ctx.respond = false;
        
        // Write headers immediately
        ctx.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        
        // Store client
        this.clients.set(clientId, {
            id: clientId,
            ctx: ctx,
            lastEventId: ctx.request.headers['last-event-id'] as string
        });
        
        // SSE client connected
        
        // Send initial connection message and flush
        const welcomeMsg = `id: ${++this.eventId}\ndata: ${JSON.stringify({ type: 'connected', message: 'Connected to movement updates', clientId })}\n\n`;
        ctx.res.write(welcomeMsg);
        if (typeof (ctx.res as any).flush === 'function') {
            (ctx.res as any).flush();
        }
        
        // Handle client disconnect
        ctx.req.on('close', () => {
            this.removeClient(clientId);
        });
        
        ctx.req.on('error', (error: Error) => {
            // "aborted" errors are normal when client navigates/re-renders
            const isAborted = error.message === 'aborted';
            if (isAborted) {
                logger.debug('SSE client connection aborted (normal during page changes)', { clientId });
            } else {
                logger.error('SSE client error', { clientId, error: error.message });
            }
            this.removeClient(clientId);
        });
        
        return clientId;
    }

    /**
     * Remove a client connection
     */
    removeClient(clientId: string): void {
        if (this.clients.has(clientId)) {
            this.clients.delete(clientId);
            // SSE client disconnected
        }
    }

    /**
     * Send data to a specific client
     */
    private sendToClient(clientId: string, data: any): boolean {
        const client = this.clients.get(clientId);
        if (!client) {
            return false;
        }

        try {
            const eventId = ++this.eventId;
            const payload = JSON.stringify(data);
            const message = `id: ${eventId}\ndata: ${payload}\n\n`;
            
            client.ctx.res.write(message);
            return true;
        } catch (error) {
            logger.error('Failed to send to client', { clientId, error: String(error) });
            this.removeClient(clientId);
            return false;
        }
    }

    /**
     * Broadcast movement update to all connected clients
     */
    broadcastMovementUpdate(event: MovementUpdateEvent): void {
        const clientIds = Array.from(this.clients.keys());
        let successCount = 0;
        
        logger.debug('Broadcasting movement update', {
            type: event.type,
            movementKey: event.movement.key,
            clients: clientIds.length
        });

        for (const clientId of clientIds) {
            if (this.sendToClient(clientId, event)) {
                successCount++;
            }
        }

        if (successCount > 0) {
            logger.debug('Movement update broadcast complete', {
                type: event.type,
                movementKey: event.movement.key,
                sent: successCount,
                failed: clientIds.length - successCount
            });
        }
    }

    /**
     * Send keep-alive ping to all clients
     */
    sendKeepAlive(): void {
        const clientIds = Array.from(this.clients.keys());
        
        for (const clientId of clientIds) {
            const client = this.clients.get(clientId);
            if (client) {
                try {
                    client.ctx.res.write(': keep-alive\n\n');
                } catch (error) {
                    logger.warn('Keep-alive failed for client', { clientId });
                    this.removeClient(clientId);
                }
            }
        }
    }

    /**
     * Get number of connected clients
     */
    getClientCount(): number {
        return this.clients.size;
    }

    /**
     * Close all client connections
     */
    closeAll(): void {
        logger.info('Closing all SSE connections', { count: this.clients.size });
        
        for (const [clientId, client] of this.clients) {
            try {
                client.ctx.res.end();
            } catch (error) {
                logger.error('Error closing client connection', { clientId, error: String(error) });
            }
        }
        
        this.clients.clear();
    }
}

// Singleton instance
export const sseManager = new SSEManager();

/**
 * Helper to format movement data for SSE broadcast
 */
export function formatMovementForSSE(key: string, movement: any): any {
    if (!movement) throw new Error(`Cannot format null movement ${key}`);
    if (!movement.startDate) throw new Error(`Movement ${key} missing startDate`);
    
    const startDate = new Date(movement.startDate);
    
    // Validate the date
    if (isNaN(startDate.getTime())) {
        throw new Error(`Movement ${key} has invalid startDate: ${movement.startDate} (${typeof movement.startDate})`);
    }
    
    return {
        key,
        startDate_en_GB: new Intl.DateTimeFormat('en-GB', {
            ...(startDate.toDateString() !== (new Date()).toDateString() && { weekday: "short" }),
            minute: "2-digit",
            hour: "2-digit",
            hour12: true
        }).format(startDate),
        movement: {
            cameraKey: movement.cameraKey,
            startDate: movement.startDate,
            startSegment: movement.startSegment,
            seconds: movement.seconds,
            detection_status: movement.detection_status || 'complete',
            processing_state: movement.processing_state,
            ...(movement.processing_error && { processing_error: movement.processing_error }),
            ...(movement.detection_output && {
                detection_output: { tags: movement.detection_output.tags || [] }
            })
        }
    };
}
