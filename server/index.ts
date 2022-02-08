const
    assert = require('assert'),
    Koa = require('koa'),
    send = require('koa-send'),
    path = require('path'),
    lexint = require('lexicographic-integer')

import { readFile, stat, readdir, mkdir } from 'fs/promises'
import { createReadStream } from 'fs'
import server_fetch from './server_fetch'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import level from 'level'
import sub from 'subleveldown'

import { JobManager, JobStatus, JobReturn, JobData, JobTask } from './jobmanager'


const VIDEO_PATH = process.env.FILEPATH || './test_video'

interface MovementEntry {
    cameraKey: number;
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
    folder: string;
    ip?: string;
    passwd?: string;
    secWithoutMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    ignore_tags: string[];
}

interface ProcessInfo {
    taskid: any
    check_after: number;
    error: boolean;
    running: boolean;
    status?: string;
}

interface Movement {
    error: boolean;
    running: boolean;
    status?: string;
    current_movement?: MovementEntry | null;
}

interface CameraEntryClient extends CameraEntry {
    key: number
    ffmpeg_process?: ProcessInfo;
    movement?: Movement;
}

interface CameraCacheEntry {
    ce: CameraEntry;
    ffmpeg_process?: ProcessInfo;
    movement?: Movement;
}

interface CameraCache { 
    [key: number]: CameraCacheEntry;
}
var cameraCache: CameraCache = {}


var spawn = require('child_process').spawn;

const db = level(process.env.DBPATH || './mydb')

const cameradb = sub(db, 'cameras', {
    valueEncoding : 'json',
    keyEncoding: {
        type: 'lexicographic-integer',
        encode: (n) => lexint.pack(n, 'hex'),
        decode: lexint.unpack,
        buffer: false
    }
})

const movementdb = sub(db, 'movements', {
    valueEncoding : 'json',
    keyEncoding: {
        type: 'lexicographic-integer',
        encode: (n) => lexint.pack(n, 'hex'),
        decode: lexint.unpack,
        buffer: false
    }
})

async function jobWorker(seq: number, d: JobData): Promise<JobReturn> {

    let newJob: JobData | null = null
    if (d.task === JobTask.ML) {

        const m: MovementEntry = await movementdb.get(d.movement_key)
        const c: CameraEntry = await cameradb.get(m.cameraKey)
        const input = `${c.folder}/image${d.movement_key}.jpg`
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
                        const mv_task = spawn('/usr/bin/mv', ['/home/kehowli/darknet/predictions.jpg', `${c.folder}/mlimage${d.movement_key}.jpg`], { timeout: 5000 })

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
        const c: CameraEntry = await cameradb.get(m.cameraKey)
        const code = await new Promise((acc, rej) => {

            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-y', '-ss', '0', '-i', `${c.folder}/stream${(m.startSegment + 1)}.ts`, '-frames:v', '1', '-q:v', '2', `${c.folder}/image${d.movement_key}.jpg`], { timeout: 120000 });
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
    return { seq, status: JobStatus.Success, ...(newJob ? { newJob } : {}) }
}


const re = new RegExp(`stream([\\d]+).ts`, 'g');

 
async function processMovement(cid: number, jobManager: JobManager) {

    const move = cameraCache[cid].movement
    if (move && move.error) return

    const ce = cameraCache[cid].ce
    try {
        
        const current_movement = move && move.current_movement

        const body_json = await server_fetch(`http://${ce.ip}/api.cgi?cmd=GetMdState&user=admin&password=${ce.passwd}`)
        const body = JSON.parse(body_json)
        //console.log(body[0].value)
        if (body[0].error) {
            cameraCache[cid].movement = {...(move), running: false, error: true, status: `fetch movement error: ${JSON.stringify(body[0])}`}
        } else if (body[0].value.state === 1) {

            if (!current_movement) {
                // get the current segment that will contain the movement
                console.log(`got movement`)

                // Need to determine the segment that corrisponds to the movement
                // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${ce.folder}/stream.m3u8`
                const hls = (await readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")
                cameraCache[cid].movement = {
                    running: true, error: false,
                    current_movement: {
                        cameraKey: cid,
                        startDate: Date.now(),
                        startSegment: parseInt(hls_segments[hls_segments.length - 1]) + 1,
                        lhs_seg_duration_seq,
                        seconds: 1,
                        consecutivesecondswithout: 0
                    }
                }
            } else {
                current_movement.seconds = current_movement.seconds + 1 + current_movement.consecutivesecondswithout
                current_movement.consecutivesecondswithout = 0
            }
        } else {
            if (current_movement) {
                if (current_movement.consecutivesecondswithout > ce.secWithoutMovement) {
                    //const filename = `${movdir}/${process.env.CAMERA_NAME}-${current_movement.startDate.getFullYear()}-${('0' + (current_movement.startDate.getMonth() + 1)).slice(-2)}-${('0' + current_movement.startDate.getDate()).slice(-2)}.csv`
                    //console.log(`writing movement`)
                    const movement_key = (current_movement.startDate / 1000 | 0) - 1600000000
                    await movementdb.put(movement_key, current_movement)

                    await jobManager.submit({ task: JobTask.Snapshot, movement_key })
                    cameraCache[cid].movement = {
                        running: true, error: false,
                        current_movement: null
                    }

                } else {
                    //console.log(`no movement`)
                    current_movement.consecutivesecondswithout++
                }
            }
        }
    } catch (e) {
        console.error(e)
    }
}


async function checkFFMpeg(cid: number): Promise<ProcessInfo> {
    //console.log (`checkFFMpeg for ${cid}`)
    const ce = cameraCache[cid].ce,
          streamfile = `${ce.folder}/stream.m3u8`

    // check the proc status
    const proc = cameraCache[cid].ffmpeg_process
    if (proc && (proc.running || proc.error )) {
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (proc.check_after && proc.check_after < Date.now())   {
            
            if (proc.running) {
                console.log (`Checking ffmpeg for [${ce.name}]`)
                try {
                    const {mtimeMs} = await stat(streamfile)
                    if (Date.now() - mtimeMs > 10000 /* 10 seconds */) {
                        console.warn (`ffmpeg no output for 10secs for ${ce.name} - file ${streamfile}, kill process`)
                        // kill and will be restarted
                        proc.taskid.kill();
                    } else {
                        // its running fine, recheck in 30secs
                        cameraCache[cid].ffmpeg_process = {...cameraCache[cid].ffmpeg_process as ProcessInfo, check_after: Date.now() + 30000}
                        return cameraCache[cid].ffmpeg_process as ProcessInfo
                    }
                } catch (e) {
                    console.warn (`cannot access ffmpeg output for ${ce.name} - file ${streamfile}, kill process`)
                    // kill and will be restarted
                    proc.taskid.kill();
                }
            } else {
                console.warn (`Try to restart failed ffmpeg for ${ce.name}`)
            }
        } else {
            // not time to re-check, just leave it
            return proc
        }
    }

    try {
        const body_json = await server_fetch(`http://${ce.ip}/cgi-bin/api.cgi?cmd=Login&token=null`, 'POST', {}, JSON.stringify([{"cmd":"Login","action":0,"param":{"User":{"userName":"admin","password": ce.passwd}}}]))
        const body = JSON.parse(body_json)
        if (body[0].error) {
            cameraCache[cid].ffmpeg_process = {taskid: null, running: false, error: true, status: `Unable to retrive token: ${JSON.stringify(body[0])}`, check_after: Date.now() + 60000};
        } else {
            const token = body[0].value.Token.name
            console.log (`ffmpeg starting [${ce.name}] : ${streamfile}...`)
            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-r', '25', '-i', `rtmp://admin:${ce.passwd}@${ce.ip}/bcs/channel0_main.bcs?token=${token}&channel=0&stream=0`, '-hide_banner', '-loglevel', 'error', '-vcodec', 'copy', '-start_number', (Date.now() / 1000 | 0) - 1600000000, streamfile ])
            cameraCache[cid].ffmpeg_process = {taskid: ffmpeg, running: true, error: false, status: 'Starting...\n', check_after: Date.now() + 30000 /* check it hasn't hung every 30seconds */};


            ffmpeg.stdout.on('data', (data: string) => {
                console.log (`ffmpeg stdout [${ce.name}]: ${data}`)
                cameraCache[cid].ffmpeg_process = {...cameraCache[cid].ffmpeg_process, status: cameraCache[cid].ffmpeg_process?.status + data.toString()} as ProcessInfo
            })
            ffmpeg.stderr.on('data', (data: string) => {
                console.warn (`ffmpeg stderr [${ce.name}]: ${data}`)
                cameraCache[cid].ffmpeg_process = {...cameraCache[cid].ffmpeg_process, status: cameraCache[cid].ffmpeg_process?.status + `StdErr: ${data}`} as ProcessInfo
            })
            ffmpeg.on('error', async (error: Error) => { 
                console.warn (`ffmpeg on-error [${ce.name}]: ${error.name}: ${error.message}`)
                cameraCache[cid].ffmpeg_process = {...cameraCache[cid].ffmpeg_process, status: cameraCache[cid].ffmpeg_process?.status + `Error: ${error.name}: ${error.message}`} as ProcessInfo
            })

            ffmpeg.on('close', async (code: number) => {
                console.warn (`ffmpeg on-close [${ce.name}]: code=${code}`)
                cameraCache[cid].ffmpeg_process = {...cameraCache[cid].ffmpeg_process, taskid: null, running: false, error: code !== 0, check_after: code !== 0? Date.now() + 30000 : Date.now()};
            });
        }

        
    } catch (e) {
        console.warn (`checkFFMpeg catch error [${ce.name}]: ${e}`)
        cameraCache[cid].ffmpeg_process = {taskid: ffmpeg, running: false, error: true, status: e as string, check_after: Date.now() + 60000};
    }

    return  cameraCache[cid].ffmpeg_process as ProcessInfo
}


const PORT = process.env.PORT || 8080

async function init_web() {

    var assets = new Router()
        .get('/image/:moment', async (ctx, next) => {
            const moment = ctx.params.moment

            try {
                const m: MovementEntry = await movementdb.get(parseInt(moment))
                const c: CameraEntry = await cameradb.get(m.cameraKey)
                const serve = `${c.folder}/${m.ml && m.ml.success ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                ctx.throw(`error e=${JSON.stringify(e)}`)
            }

        })
        .get('/video/live/:cid/:file', async (ctx, next) => {
            const cid = ctx.params.cid,
                  file = ctx.params.file
            if (isNaN(cid as any)) {
                ctx.status = 404
            } else {
                try {
                    const c = await cameradb.get(parseInt(cid))            
                    const serve = `${c.folder}/${file}`
                    const { size } = await stat(serve)
                    //console.log(`serving : ${serve}`)
                    ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
                } catch (e) {
                    ctx.throw(`error e=${JSON.stringify(e)}`)
                }
            }
        })
        .get('/video/:mid/:file', async (ctx, next) => {
            const movement = ctx.params.mid,
                  file = ctx.params.file

            //need to cache this in memory!!
            const m: MovementEntry = await movementdb.get(parseInt(movement))
            const ce: CameraEntry = cameraCache[m.cameraKey].ce

            if (file.endsWith('.m3u8')) {

                const preseq: number = ctx.query.preseq ? parseInt(ctx.query.preseq as any) : 1
                const postseq: number = ctx.query.postseq ? parseInt(ctx.query.postseq as any) : 1
                // need to return a segement file for the movement
                try {
                    

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${m.lhs_seg_duration_seq}
` + [...Array(Math.round(m.seconds / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
${ce.name}.${n + m.startSegment - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"

                    ctx.body = body
                } catch (e) {
                    ctx.throw(`unknown movement name=${movement}`)
                }
            } else if (file.endsWith('.ts')) {
                const [camera, index, suffix] = file.split('.')
                const serve = `${ce.folder}/stream${index}.${suffix}`
                //console.log(`serving : ${serve}`)
                try {
                    const { size } = await stat(serve)
                    ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
                } catch (e) {
                    ctx.throw(`error e=${JSON.stringify(e)}`)
                }
            } else {
                ctx.throw(`unknown file=${file}`)
            }

        }).get('/mp4/:movement', async (ctx, next) => {
            const movement = ctx.params.movement

            const preseq: number = ctx.query.preseq ? parseInt(ctx.query.preseq as any) : -1
            const postseq: number = ctx.query.postseq ? parseInt(ctx.query.postseq as any) : -1

            try {
                const m: MovementEntry = await movementdb.get(parseInt(movement))
                const ce: CameraEntry = await cameraCache[m.cameraKey].ce

                const serve = `${ce.folder}/save${movement}.mp4`

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
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)

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
            console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env.WEBPATH || './build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/camera/:id', async (ctx, next) => {
            
            const cid = ctx.params.id
            console.log (`camera save ${cid} -  ${JSON.stringify(ctx.request.body)}`)
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body

                if (cid === 'new') {
                    // creating new entry
                    try {
                        await mkdir (new_ce.folder)
                    } catch (e) {
                        console.warn (`failed to create dir : ${new_ce.folder}`)
                    }
                    const new_key = (Date.now() / 1000 | 0) - 1600000000
                    await cameradb.put(new_key, new_ce)
                    cameraCache[new_key] = {ce: new_ce }
 
 
                    ctx.status = 201
                } else {
                    if (isNaN(cid as any)) { 
                        console.warn (`isNaN : ${cid}`)
                        ctx.status = 404
                    } else {
                        // updating existing camera
                        try {
                            const key = parseInt(cid)
                            const old_ce = await cameradb.get(key)
                            if (old_ce.folder != new_ce.folder) {
                                console.log ('creating directory')
                                try {
                                 await mkdir (new_ce.folder)
                                } catch (e) {
                                    console.warn (`failed to create dir : ${new_ce.folder}`)
                                }
                            }
                            
                            const new_vals = {...old_ce, ...new_ce}
                            await cameradb.put(key, new_vals) 
                            cameraCache[key].ce = new_ce

                            ctx.status = 201
                        } catch (e) {
                            console.warn (`try error : ${e}`)
                            ctx.status = 404
                        }
                    }
                }
                
            } else {
                ctx.status = 500
            }
        }).post('/movements/:id', async (ctx, next) => {
            const cid = ctx.params.camera
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: any = ctx.request.body
                const cmd = confirmed.map((m: any) => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
        }).get('/movements', async (ctx, next) => {

            const cameras: CameraEntryClient[] = Object.keys(cameraCache).map((k) => {
                const key = parseInt(k)
                const c = cameraCache[key]
                // filer out data not for the client
                const {ip, passwd, ...cameraEntry} = c.ce
                const {current_movement, ...movement} = c.movement || {}
                const {taskid, ...ffmpeg_process} = c.ffmpeg_process || {}
                return {key, ...cameraEntry, ffmpeg_process, movement} as CameraEntryClient
            })

            // find first segment on disk
            async function findFirstSegmentOnDisk(c: CameraEntry): Promise<{sequence: number, ctimeMs: number}> {
                let first_seq_on_disk: number = 0
                const local_video = await readdir(c.folder)
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
                const {ctimeMs} = await stat (`${c.folder}/stream${first_seq_on_disk}.ts`)
                return {sequence: first_seq_on_disk, ctimeMs}
            }

            let oldestctimeMs = 0
            for (let c of cameras) {
                try {
                    const {ctimeMs} = await findFirstSegmentOnDisk(c)
                    if (oldestctimeMs === 0 || ctimeMs < oldestctimeMs ) oldestctimeMs = ctimeMs
                } catch (e) {
                    console.error (`findFirstSegmentOnDisk error`, e)
                }
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

        })

    const nav = new Router()
        .get('/live', async (ctx, next) => {
            ctx.redirect(`http://${process.env.CAMERA_IP}`)
        })
        .get('/network', async (ctx, next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3998`)
        })
        .get('/metrics', async (ctx, next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3000/d/T3OrKihMk/our-house?orgId=1`)
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

    const jobman = new JobManager(db, 1, jobWorker)
    jobman.start(false)

    // populate camera cache, and clear all
    await new Promise((res, rej) => {
        cameradb.createReadStream()
            .on('data', (data) => {
                const { key, value } = data as {key: number, value: CameraEntry}
                cameraCache[key] = {ce: value}
            })
            .on('end', () => {
                res(0)
            })
    })

    async function controll_loop() {
        for (let cid of Object.keys(cameraCache)) {
            const cid_int = parseInt(cid)
            const pi = await checkFFMpeg(cid_int)
            if (pi.running) {
                await processMovement(cid_int, jobman)
            }
        }
    }

    // Start the Polling process
    setInterval(controll_loop, 1000)

    init_web()

    //db.close()
}

main()
