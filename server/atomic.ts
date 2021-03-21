export interface AtomicInterface {
    aquire(): Promise<() => void>;

}

// 
// Big thanks to https://github.com/DirtyHairy/async-mutex/blob/master/src/Semaphore.ts
export class Atomic implements AtomicInterface {

    private _queue: Array<(lease: [number, () => void]) => void> = [];
    private _currentReleaser: undefined | (() => void);
    private _value: number = 1;

    constructor(concurrency: number) {
        this._value = concurrency
        this._currentReleaser = undefined
    }

    isLocked() {
        return this._value <= 0;
    }


    async aquire() {
        const locked = this.isLocked();
        const ticket = new Promise<[number, () => void]>((r) => this._queue.push(r))
        if (!locked) this._dispatch()
        const [, releaser] = await ticket
        return releaser
    }

    _dispatch() {
        const nextConsumer = this._queue.shift();
        if (!nextConsumer) return;
        let released = false;
        this._currentReleaser = () => {
            if (released) return;

            released = true;
            this._value++;

            this._dispatch();
        };
        nextConsumer([this._value--, this._currentReleaser]);
    }

    release() {
        if (this._currentReleaser) {
            const releaser = this._currentReleaser;
            this._currentReleaser = undefined;

            releaser();
        }
    }
}