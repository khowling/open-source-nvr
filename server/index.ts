const
    assert = require('assert'),
    Koa = require('koa'),
    send = require('koa-send'),
    path = require('path'),
    lexint = require('lexicographic-integer'),
    leveldown = require('leveldown')

import { readFile, stat, readdir } from 'fs/promises'
import { createReadStream } from 'fs'
import server_fetch from './server_fetch'
import Router from 'koa-router'
import bodyParser from 'koa-bodyparser'
import level, { LevelUp } from 'levelup'
import sub from 'subleveldown'

import { JobManager, JobStatus, JobReturn, JobData, JobTask } from './jobmanager'

assert(process.env.FILEPATH, "FILEPATH not set")
assert(process.env.CAMERA_NAME, "CAMERA_NAME not set")

const VIDEO_PATH = `${process.env.FILEPATH}`

interface MovementEntry {
    cameraName: string;
    startDate: number;
    startSegment: number;
    lhs_seg_duration_seq: number;
    seconds: number;
    consecutivesecondswithout: number;
    ml?: MLData;
    ml_movejpg?: SpawnData;
    ffmpeg?: SpawnData;
}

interface MovementReadStream {
    key: number;
    value: MovementEntry;
}

interface MovementToClient {
    key: number;
    movement: MovementEntry;
    startDateGb: string;
}

interface SpawnData {
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
    error: string;
}
interface MLData extends SpawnData {
    tags: any[];
}

interface CameraEntry {
    name: string;
    ip: string;
    passwd: string;
    secWithoutMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    ignore_tags: string[];
}

var spawn = require('child_process').spawn;

const db = level(leveldown(process.env.DBPATH || './mydb'))

const cameradb: LevelUp = sub(db, 'cameras', {
    valueEncoding: 'json'
})

const movementdb: LevelUp = sub(db, 'movements', {
    keyEncoding: {
        type: 'lexicographic-integer',
        encode: (n) => lexint.pack(n, 'hex'),
        decode: lexint.unpack,
        buffer: false
    }, valueEncoding: 'json'
})

var movementIntervals: NodeJS.Timeout[] = []


async function jobWorker(seq: number, d: JobData): Promise<JobReturn> {

    let newJob: JobData | null = null
    if (d.task === JobTask.ML) {

        const m: MovementEntry = await movementdb.get(d.movement_key)
        const input = `${VIDEO_PATH}/${m.cameraName}/image${d.movement_key}.jpg`
        const code = await new Promise((acc, rej) => {
            let ml_stdout = '', ml_stderr = '', ml_error = ''
            const ml_task = spawn('./darknet', ['detect', 'cfg/yolov3.cfg', 'cfg/yolov3.weights', input], { cwd: '/home/kehowli/darknet', timeout: 120000 });

            ml_task.stdout.on('data', (data: string) => { ml_stdout += data })
            ml_task.stderr.on('data', (data: string) => { ml_stderr += data })
            ml_task.on('error', async (error: Error) => { ml_error = `${error.name}: ${error.message}` })

            // The 'close' event will always emit after 'exit' was already emitted, or 'error' if the child failed to spawn.
            ml_task.on('close', async (code: number) => {
                const ml: MLData = { success: code === 0, code, stderr: ml_stderr, stdout: ml_stdout, error: ml_error, tags: [] }
                if (code === 0) {
                    let mltags = ml_stdout.match(/([\w]+): ([\d]+)%/g)
                    if (mltags) {

                        ml.tags = mltags.map(d => { const i = d.indexOf(': '); return { tag: d.substr(0, i), probability: parseInt(d.substr(i + 2, d.length - i - 3)) } })
                        await movementdb.put(d.movement_key, { ...m, ml } as MovementEntry)

                        let mv_stdout = '', mv_stderr = '', mv_error = ''
                        const mv_task = spawn('/usr/bin/mv', ['/home/kehowli/darknet/predictions.jpg', `${VIDEO_PATH}/${m.cameraName}/mlimage${d.movement_key}.jpg`], { timeout: 5000 })

                        mv_task.stdout.on('data', (data: string) => { mv_stdout += data })
                        mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
                        mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

                        mv_task.on('close', async (code: number) => {
                            await movementdb.put(d.movement_key, { ...m, ml, ml_movejpg: { success: code === 0, stderr: mv_stderr, stdout: mv_stdout, error: mv_error } as SpawnData })
                            acc(code)
                        })
                    } else {
                        await movementdb.put(d.movement_key, { ...m, ml })
                        acc(code)
                    }

                } else {
                    await movementdb.put(d.movement_key, { ...m, ml })
                    acc(code)
                }

            });

        })

    } else if (d.task === JobTask.Snapshot) {
        // Take a single frame snapshot to corispond to the start of the movement segment recorded in startSegment.
        // -ss seek to the first frame in the segment file

        const m: MovementEntry = await movementdb.get(d.movement_key)
        const code = await new Promise((acc, rej) => {

            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-y', '-ss', '0', '-i', `${VIDEO_PATH}/${m.cameraName}/stream${(m.startSegment + 1)}.ts`, '-frames:v', '1', '-q:v', '2', `${VIDEO_PATH}/${m.cameraName}/image${d.movement_key}.jpg`], { timeout: 120000 });
            let ff_stdout = '', ff_stderr = '', ff_error = ''

            ffmpeg.stdout.on('data', (data: string) => { ff_stdout += data })
            ffmpeg.stderr.on('data', (data: string) => { ff_stderr += data })
            ffmpeg.on('error', async (error: Error) => { ff_error = `${error.name}: ${error.message}` })

            ffmpeg.on('close', async (code: number) => {
                await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: code === 0, stderr: ff_stderr, stdout: ff_stdout, error: ff_error } as SpawnData })
                if (code === 0) {
                    newJob = { task: JobTask.ML, movement_key: d.movement_key }
                }
                acc(code)
            });
        })
    }
    return { seq, status: JobStatus.Success, ...(newJob && { newJob }) }
}


async function init_movement_poll(jobManager: JobManager) {

    const re = new RegExp(`stream([\\d]+).ts`, 'g');

    let movement_entry: MovementEntry
    async function processMovement(camera: CameraEntry) {
        try {
            const body_json = await server_fetch(`http://${camera.ip}/api.cgi?cmd=GetMdState&user=admin&password=${camera.passwd}`)
            const body = JSON.parse(body_json)
            //console.log(body[0].value)
            if (body[0].value.state === 1) {

                if (!movement_entry) {
                    // get the current segment that will contain the movement
                    console.log(`got movement`)

                    // Need to determine the segment that corrisponds to the movement
                    // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                    // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                    const filepath = `${VIDEO_PATH}/${camera.name}/stream.m3u8`
                    const hls = (await readFile(filepath)).toString()
                    const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                    const lhs_seg_duration_seq = parseInt(hls.match(/#EXT-X-TARGETDURATION:([\d])/)[1])
                    movement_entry = {
                        cameraName: camera.name,
                        startDate: Date.now(),
                        startSegment: parseInt(hls_segments[hls_segments.length - 1]) + 1,
                        lhs_seg_duration_seq,
                        seconds: 1,
                        consecutivesecondswithout: 0
                    }
                } else {
                    movement_entry.seconds = movement_entry.seconds + 1 + movement_entry.consecutivesecondswithout
                    movement_entry.consecutivesecondswithout = 0
                }
            } else {
                if (movement_entry) {
                    if (movement_entry.consecutivesecondswithout > camera.secWithoutMovement) {
                        //const filename = `${movdir}/${process.env.CAMERA_NAME}-${movement_entry.startDate.getFullYear()}-${('0' + (movement_entry.startDate.getMonth() + 1)).slice(-2)}-${('0' + movement_entry.startDate.getDate()).slice(-2)}.csv`
                        //console.log(`writing movement`)
                        const movement_key = (movement_entry.startDate / 1000 | 0) - 1600000000
                        await movementdb.put(movement_key, movement_entry)

                        await jobManager.submit({ task: JobTask.Snapshot, movement_key })
                        movement_entry = null

                    } else {
                        //console.log(`no movement`)
                        movement_entry.consecutivesecondswithout++
                    }
                }
            }
        } catch (e) {
            console.error(e)
        }
    }

    // shut down all current polls
    for (let m of movementIntervals) {
        clearInterval(m)
    }

    await new Promise((res, rej) => {
        cameradb.createValueStream()
            .on('data', (c: CameraEntry) => {
                if (c.mSPollFrequency > 0) {
                    movementIntervals.push(setInterval(processMovement, c.mSPollFrequency, c))
                }
            })
            .on('end', () => {
                res(0)
            })
    })


}


const PORT = process.env.PORT || 8080

async function init_web() {

    var assets = new Router()
        .get('/image/:moment', async (ctx, next) => {
            const moment = ctx.params.moment

            try {
                const m: MovementEntry = await movementdb.get(parseInt(moment))
                const serve = `${VIDEO_PATH}/${m.cameraName}/${m.ml && m.ml.success ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
            } catch (e) {
                ctx.throw(`error e=${JSON.stringify(e)}`)
            }

        })
        .get('/video/:movement/:file', async (ctx, next) => {
            const movement = ctx.params.movement
            const file = ctx.params.file

            //console.log(`camera_name=${camera_name} movement=${movement} file=${file}`)

            // It is not a number, assume its a camera name, otherwise throw a error
            if (isNaN(movement as any)) {
                try {
                    const camera = await cameradb.get(movement)
                    try {
                        const serve = `${VIDEO_PATH}/${camera.name}/${file}`
                        const { size } = await stat(serve)
                        //console.log(`serving : ${serve}`)
                        ctx.body = createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
                    } catch (e) {
                        ctx.throw(`error e=${JSON.stringify(e)}`)
                    }
                } catch (e) {
                    ctx.throw(`unknown camera name=${movement}`)
                }


                // If its a number, assume its a movement key
            } else {

                if (file.endsWith('.m3u8')) {

                    const preseq: number = ctx.query.preseq ? parseInt(ctx.query.preseq as any) : 1
                    const postseq: number = ctx.query.postseq ? parseInt(ctx.query.postseq as any) : 1
                    // need to return a segement file for the movement
                    try {
                        const m: MovementEntry = await movementdb.get(parseInt(movement))
                        const c: CameraEntry = await cameradb.get(m.cameraName)

                        const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${m.lhs_seg_duration_seq}
` + [...Array(Math.round(m.seconds / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
${m.cameraName}.${n + m.startSegment - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"

                        ctx.body = body
                    } catch (e) {
                        ctx.throw(`unknown movement name=${movement}`)
                    }
                } else if (file.endsWith('.ts')) {
                    const [camera, index, suffix] = file.split('.')
                    const serve = `${VIDEO_PATH}/${camera}/stream${index}.${suffix}`
                    //console.log(`serving : ${serve}`)
                    try {
                        const { size } = await stat(serve)
                        ctx.body = createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
                    } catch (e) {
                        ctx.throw(`error e=${JSON.stringify(e)}`)
                    }
                } else {
                    ctx.throw(`unknown file=${file}`)
                }
            }

        }).get('/mp4/:movement', async (ctx, next) => {
            const movement = ctx.params.movement

            const preseq: number = ctx.query.preseq ? parseInt(ctx.query.preseq as any) : -1
            const postseq: number = ctx.query.postseq ? parseInt(ctx.query.postseq as any) : -1

            try {
                const m: MovementEntry = await movementdb.get(parseInt(movement))
                const serve = `${VIDEO_PATH}/${m.cameraName}/save${movement}.mp4`

                await new Promise(async (res, rej) => {
                    const mv_task = spawn('/usr/bin/ffmpeg', ['-y', '-i', `http://localhost:${PORT}/video/${movement}/stream.m3u8${preseq > 0 && postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve], { timeout: 5000 })
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
                ctx.body = createReadStream(serve, { encoding: null }).on('error', ctx.onerror)

            } catch (e) {
                ctx.throw(`error mp4 gen error=${e}`)
            }

        }).get('/mp4old/:movement', async (ctx, next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `${VIDEO_PATH}/${ctx.params[0]}`
            let streamoptions: any = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await stat(filepath)

                const [range_start, range_end] = ctx.headers.range.replace(/bytes=/, "").split("-"),
                    start = parseInt(range_start, 10),
                    chunklength = range_end ? parseInt(range_end, 10) - start + 1 : Math.min(1024 * 1024 * 32 /* 32KB default */, size - start /* whats left in the file */),
                    end = start + chunklength - 1

                console.log(`serving video request range: ${range_start} -> ${range_end},  providing ${start} -> ${end} / ${size}`)

                ctx.set('Accept-Ranges', 'bytes');
                ctx.set('Content-Length', chunklength.toString()) // 38245154
                ctx.set('Content-Range', `bytes ${start}-${end}/${size}`) // bytes 29556736-67801889/67801890

                streamoptions = { ...streamoptions, start, end }
                ctx.status = 206;
            }
            ctx.body = createReadStream(filepath, streamoptions).on('error', ctx.onerror)

        }).get(['/(.*)'], async (ctx, next) => {
            const path = ctx.params[0]
            //console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env.WEBPATH || './build' })
        })

    const api = new Router({ prefix: '/api' })
        .get('/cameras', async (ctx, next) => {
            ctx.body = [
                {
                    name: process.env.CAMERA_NAME
                }
            ]
        }).post('/movements/:camera', async (ctx, next) => {
            const camera = ctx.params.camera
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: any = ctx.request.body
                const cmd = confirmed.map((m: any) => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
        }).get('/movements', async (ctx, next) => {
            //const camera = ctx.params.camera


            let cameras: CameraEntry[] = await new Promise((res, rej) => {
                let cameras: CameraEntry[] = []
                cameradb.createValueStream()
                    .on('data', (c: CameraEntry) => {
                        // Dont send password or IP to client
                        const { name, secWithoutMovement, mSPollFrequency, segments_prior_to_movement, segments_post_movement, ignore_tags } = c
                        cameras.push({ name, secWithoutMovement, mSPollFrequency, segments_prior_to_movement, segments_post_movement, ignore_tags, ip: null, passwd: null })
                    })
                    .on('end', () => {
                        res(cameras)
                    })
            })

            // find first segment on disk
            async function findFirstSegmentOnDisk(cameraName: string, video_path: string): Promise<{sequence: number, ctimeMs: number}> {
                let first_seq_on_disk: number = 0
                const local_video_path = `${video_path}/${cameraName}`
                const local_video = await readdir(local_video_path)
                const local_video_re = new RegExp(`^stream(\\d+).ts`)
                // For each file in the directory
                for (let dir_entry of local_video) {
                    const entry_match = dir_entry.match(local_video_re)
                    // check the filename is from ffmpeg (not a image or anything else)
                    if (entry_match) {
                        const [file, seq] = entry_match
                        const seq_num = parseInt(seq)
                        if (first_seq_on_disk === 0) {
                            first_seq_on_disk = seq_num
                        } else if (seq_num < first_seq_on_disk) {
                            first_seq_on_disk = seq_num
                        }
                    }
                }
                const {ctimeMs} = await stat (`${local_video_path}/stream${first_seq_on_disk}.ts`)
                return {sequence: first_seq_on_disk, ctimeMs}
            }

            let oldestctimeMs = 0
            for (let c of cameras) {
                const {ctimeMs} = await findFirstSegmentOnDisk(c.name, VIDEO_PATH)
                if (oldestctimeMs === 0 || ctimeMs < oldestctimeMs ) oldestctimeMs = ctimeMs
            }

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res, rej) => {
                let movements: MovementToClient[] = []

                // Everything in movementdb, with key time (movement start date) greater than the creation date of the oldest sequence file on disk
                const feed = movementdb.createReadStream({ reverse: true, gt: oldestctimeMs > 0 ? (oldestctimeMs / 1000 | 0) - 1600000000 : 0 })
                    .on('data', (m: MovementReadStream) => {
                            movements.push({
                                key: m.key,
                                startDateGb: new Intl.DateTimeFormat('en-GB', { /*dateStyle: 'full',*/ timeStyle: 'medium', hour12: true }).format(new Date(m.value.startDate)),
                                movement: m.value
                            })
                        //}
                    }).on('end', () => {
                        res(JSON.stringify({ cameras, movements }))
                    })
            })

            //movementdb.createValueStream()

        })
    /*.get('/movements/:mode*', async (ctx, next) => {

        const mode = ctx.params.mode

        function add_in_order(new_val, array) {

            for (let i = 0; i < array.length; i++) {
                if (new_val.start <= array[i].start) {
                    return [...array.slice(0, i), new_val, ...array.slice(new_val.start === array[i].start ? i + 1 : i)]
                }
            }
            return [...array, new_val]
        }

        let sorted_mp4 = []
        const local_video = await fs.promises.readdir(mp4dir)
        const local_video_re = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2}).mp4`)
        for (let dir_entry of local_video) {
            const entry_match = dir_entry.match(local_video_re)
            if (entry_match) {
                const [file, year, month, day, hour, minute, second] = entry_match
                const start = new Date(year, month - 1, day, hour, minute, second)
                sorted_mp4 = add_in_order({ start: start.getTime(), file }, sorted_mp4)
            }
        }



        async function readFiles(dir, labels, newerthan) {
            let sorted_out = []
            const movement_dir = await fs.promises.readdir(dir)
            const movement_re = new RegExp(`^${process.env.CAMERA_NAME}-(\\d{4})-(\\d{2})-(\\d{2}).csv`)
            for (let dir_entry of movement_dir) {
                const entry_match = dir_entry.match(movement_re)
                if (entry_match) {
                    const [file, year, month, day] = entry_match
                    if (file, new Date(year, parseInt(month) - 1, day).getTime() >= newerthan) {
                        const data = await fs.promises.readFile(dir + '/' + file, 'UTF-8')
                        for (let mov_line of data.split(/\r?\n/)) {
                            const [start, ...rest] = mov_line.split(';')
                            if (start) {
                                sorted_out = add_in_order({ key: start, start: new Date(start).getTime(), ...rest.reduce((o, v, i) => { return { ...o, [labels[i]]: v } }, {}) }, sorted_out)
                            }
                        }
                    }
                }
            }
            return sorted_out
        }

        if (mode === "video_only") {
            ctx.body = sorted_mp4

        } else if (sorted_mp4.length > 0) {

            const oldest_mp4 = new Date(sorted_mp4[0].start),
                oldest_mp4_date = new Date(oldest_mp4.getFullYear(), oldest_mp4.getMonth(), oldest_mp4.getDate()).getTime()


            const sorted_mov = await readFiles(movdir, ["duration"], oldest_mp4_date)
            const sorted_web = await readFiles(webdir, ["file", "reviewed", "save"], oldest_mp4_date)

            let mp4_idx = 0
            let web_idx = 0

            const MAX_MP4_DURATION_SEC = 60 * 60 * 2 // 2hrs
            ctx.body = sorted_mov.map(function (mov) {
                let out = { movement_key: mov.key, start: new Date(mov.start).toUTCString().replace(/ \d{4}/, "").replace(/ GMT$/, ""), duration: mov.duration }

                // match movement entry to mp4 file and starttime
                while (mp4_idx < sorted_mp4.length) {
                    const curr_mp4_start = sorted_mp4[mp4_idx].start
                    if (mov.start >= curr_mp4_start) {
                        // movemet time is greater than current mp4 start time
                        const next_mp4_start = (mp4_idx + 1 < sorted_mp4.length) ? sorted_mp4[mp4_idx + 1].start : null
                        if (next_mp4_start === null || mov.start < next_mp4_start) {
                            const index_in_seconds = parseInt((mov.start - curr_mp4_start) / 1000, 10)
                            if (index_in_seconds < MAX_MP4_DURATION_SEC) {
                                out = { ...out, video: { file: sorted_mp4[mp4_idx].file, index: index_in_seconds } }
                            }
                            break
                        } else {
                            // movement time is after or equal the next mp4 start time
                            mp4_idx++
                        }

                    } else {
                        // movemet time is older than current mp4 (mp4 no longer on local disk!)
                        break
                    }
                }

                // match movement entry to updates from web
                while (web_idx < sorted_web.length) {
                    const curr_web_start = sorted_web[web_idx].start
                    if (mov.start === curr_web_start) {
                        out = { ...out, web: sorted_web[web_idx] }
                        break
                    } else if (mov.start < sorted_web[web_idx].start) {
                        break
                    }
                    web_idx++
                }

                return out

            }).filter(i => i.video ? (i.web ? i.web.reviewed === "false" : true) : false)
        } else {
            ctx.body = []
        }
       
    })
*/
    const nav = new Router()
        .get('/live', async (ctx, next) => {
            ctx.redirect(`http://${process.env.CAMERA_IP}`)
        })
        .get('/network', async (ctx, next) => {
            ctx.redirect(`http://${ctx.headers.host.split(":")[0]}:3998`)
        })
        .get('/metrics', async (ctx, next) => {
            ctx.redirect(`http://${ctx.headers.host.split(":")[0]}:3000/d/T3OrKihMk/our-house?orgId=1`)
        })

    const app = new Koa()
    app.use(bodyParser())
    app.use(api.routes())
    app.use(nav.routes())
    app.use(assets.routes())
    /*
        app.use(async (ctx) => {
            
            })
    */
    console.log(`Starting on 8080..`)
    app.listen(8080)
}

async function main() {

    await cameradb.put(process.env.CAMERA_NAME, {
        name: process.env.CAMERA_NAME,
        ip: process.env.CAMERA_IP,
        passwd: process.env.CAMERA_PASSWD,
        secWithoutMovement: 10,
        mSPollFrequency: 1000,
        segments_prior_to_movement: 10, // 20 seconds (2second segments)
        segments_post_movement: 10, // 20 seconds (2second segments)
        ignore_tags: ['car']
    } as CameraEntry)


    const jobman = new JobManager(db, 1, jobWorker)
    jobman.start(false)

    init_movement_poll(jobman)
    init_web()

    //db.close()
}

main()
