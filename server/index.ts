const
    Koa = require('koa'),
    send = require('koa-send'),
    lexint = require('lexicographic-integer')

import fs from 'fs/promises'
import { createReadStream } from 'fs'
import server_fetch from './server_fetch.js'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import level from 'level'
import sub from 'subleveldown'
import { diskCheck } from './diskcheck.js'

import { JobManager, JobStatus, JobReturn, JobData, JobTask } from './jobmanager.js'

interface Settings {
    disk_base_dir: string;
    enable_cleanup: boolean;
    cleanup_interval: number;
    cleanup_capacity: number;
    enable_ml: boolean;
    darknetDir: string;
}
interface MovementEntry {
    cameraKey: string;
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
    disk: string;
    ip?: string;
    passwd?: string;
    enable_streaming: boolean;
    enable_movement: boolean;
    secWithoutMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    ignore_tags: string[];
}

interface ProcessInfo {
    taskid: ChildProcessWithoutNullStreams | null;
    check_after?: number;
    in_progress: boolean;
    error: boolean;
    running: boolean;
    status: string;
}

interface Movement {
    error: boolean;
    running: boolean;
    status?: string;
    current_movement?: MovementEntry | null;
}

interface CameraEntryClient extends CameraEntry {
    key: string
    ffmpeg_process?: ProcessInfo;
    movement?: Movement;
}

interface CameraCacheEntry {
    ce: CameraEntry;
    ffmpeg_process?: ProcessInfo;
    movement?: Movement;
}

interface CameraCache { 
    [key: string]: CameraCacheEntry;
}
var cameraCache: CameraCache = {}

var settingsCache: {
    settings: Settings;
    status: any;
}


import { ChildProcessWithoutNullStreams, spawn} from 'child_process'

const db = level(process.env['DBPATH'] || './mydb',  { valueEncoding : 'json' })
const cameradb = sub(db, 'cameras', { valueEncoding : 'json' })
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
        const input = `${c.disk}/${c.folder}/image${d.movement_key}.jpg`
        await new Promise((acc, _rej) => {
            let ml_stdout = '', ml_stderr = '', ml_error = ''
            const ml_task = spawn('./darknet', ['detect', 'cfg/yolov3.cfg', 'cfg/yolov3.weights', input], { cwd: settingsCache.settings.darknetDir, timeout: 120000 });

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
                        const mv_task = spawn('/usr/bin/mv', [`${settingsCache.settings.darknetDir}/predictions.jpg`, `${c.disk}/${c.folder}/mlimage${d.movement_key}.jpg`], { timeout: 5000 })

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
        const code = await new Promise((acc, _rej) => {

            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-y', '-ss', '0', '-i', `${c.disk}/${c.folder}/stream${(m.startSegment + 1)}.ts`, '-frames:v', '1', '-q:v', '2', `${c.disk}/${c.folder}/image${d.movement_key}.jpg`], { timeout: 120000 });
            let ff_stdout = '', ff_stderr = '', ff_error = ''

            ffmpeg.stdout.on('data', (data: string) => { ff_stdout += data })
            ffmpeg.stderr.on('data', (data: string) => { ff_stderr += data })
            ffmpeg.on('error', async (error: Error) => { ff_error = `${error.name}: ${error.message}` })

            ffmpeg.on('close', async (code: number) => {
                await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: code === 0, stderr: ff_stderr, stdout: ff_stdout, error: ff_error } as SpawnData })
                if (code === 0 && settingsCache.settings.enable_ml) {
                    newJob = { task: JobTask.ML, movement_key: d.movement_key }
                }
                acc(code)
            });
        })
    }
    return { seq, status: JobStatus.Success, ...(newJob ? { newJob } : {}) }
}


const re = new RegExp(`stream([\\d]+).ts`, 'g');

 
async function processMovement(cameraKey: string, jobManager: JobManager) {

    const move = cameraCache[cameraKey].movement
    if (move && move.error) return

    const ce = cameraCache[cameraKey].ce
    try {
        
        const current_movement = move && move.current_movement

        const body_json = await server_fetch(`http://${ce.ip}/api.cgi?cmd=GetMdState&user=admin&password=${ce.passwd}`, {timeout: 500})
        const body = JSON.parse(body_json)
        //console.log(body[0].value)
        if (body[0].error) {
            cameraCache[cameraKey].movement = {...(move), running: false, error: true, status: `fetch movement error: ${JSON.stringify(body[0])}`}
        } else if (body[0].value.state === 1) {

            if (!current_movement) {
                // get the current segment that will contain the movement
                console.log(`got movement`)

                // Need to determine the segment that corrisponds to the movement
                // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${ce.disk}/${ce.folder}/stream.m3u8`
                const hls = (await fs.readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")
                cameraCache[cameraKey].movement = {
                    running: true, error: false,
                    current_movement: {
                        cameraKey,
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
                    cameraCache[cameraKey].movement = {
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


async function StreamingController(cameraKey: string): Promise<ProcessInfo | undefined> {
    //console.log (`StreamingController for ${cameraKey}`)
    const ce = cameraCache[cameraKey].ce,
          streamfile = `${ce.disk}/${ce.folder}/stream.m3u8`,
          proc = cameraCache[cameraKey].ffmpeg_process

    // chkecFFMpeg still running from last interval, skip this check.
    if (proc?.in_progress) {
        return proc
    }

    // No streaming enabled
    if (!ce.enable_streaming) {
        if (proc?.running) {
            proc.taskid?.kill();
        }
        return proc
    }

    // check if ffmpeg has stopped, or has shopped producing output
    if (proc) {
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (proc.check_after && proc.check_after < Date.now())   {
            
            if (proc.running) {
                console.log (`Checking ffmpeg for [${ce.name}] running=${proc.running} error=${proc.error}...`)
                try {
                    const {mtimeMs} = await fs.stat(streamfile),
                           last_updated_ago = Date.now() - mtimeMs
                    if (last_updated_ago > 10000 /* 10 seconds */) {
                        console.warn (`ffmpeg no output for 10secs for ${ce.name} - file ${streamfile}, kill process`)
                        // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                        proc.taskid?.kill();
                    } else {
                        // its running fine, recheck in 30secs
                        console.log (`Checking ffmpeg for [${ce.name}], all good, last_updated_ago=${last_updated_ago}mS, check again in 1minute`)
                        cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process as ProcessInfo, check_after: Date.now() + 60000}
                    }
                } catch (e) {
                    console.warn (`cannot access ffmpeg output for ${ce.name} - file ${streamfile}, kill process`)
                    // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                    proc.taskid?.kill();
                }

                return cameraCache[cameraKey].ffmpeg_process as ProcessInfo

            } else {
                console.warn (`Try to restart failed or stopped ffmpeg for [${ce.name}] running=${proc.running} error=${proc.error}`)
            }
        } else {
            // not time to re-check, just leave it
            return proc
        }
    }

    // start ffmpeg
    try {
        console.log ((new Date()).toTimeString().substring(0,8) + ` Getting token for [${ce.name}]...`)
        cameraCache[cameraKey].ffmpeg_process = {taskid: null, running: false, error: false, in_progress: true, status: 'Getting token'}
        
        const body_json = await server_fetch(`http://${ce.ip}/cgi-bin/api.cgi?cmd=Login&token=null`, {timeout: 500}, [{"cmd":"Login","action":0,"param":{"User":{"userName":"admin","password": ce.passwd}}}])
        const body = JSON.parse(body_json)
        if (body[0].error) {
            cameraCache[cameraKey].ffmpeg_process = {taskid: null, running: false, error: true, in_progress: false, status: `Unable to retrive token: ${JSON.stringify(body[0])}`, check_after: Date.now() + 60000};
        } else {
            const token = body[0].value.Token.name
            console.log ((new Date()).toTimeString().substring(0,8) + ` starting ffmpeg for [${ce.name}] : ${streamfile}...`)
            var ffmpeg : ChildProcessWithoutNullStreams = spawn('/usr/bin/ffmpeg', ['-r', '25', '-i', `rtmp://admin:${ce.passwd}@${ce.ip}/bcs/channel0_main.bcs?token=${token}&channel=0&stream=0`, '-hide_banner', '-loglevel', 'error', '-vcodec', 'copy', '-start_number', ((Date.now() / 1000 | 0) - 1600000000).toString(), streamfile ])
            cameraCache[cameraKey].ffmpeg_process = {taskid: ffmpeg, running: true, error: false, in_progress: false, status: 'Starting...\n', check_after: Date.now() + 60000 /* check it hasn't hung every 30seconds */};


            ffmpeg.stdout.on('data', (data: string) => {
                console.log (`ffmpeg stdout [${ce.name}]: ${data}`)
                cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + data.toString()} as ProcessInfo
            })
            ffmpeg.stderr.on('data', (data: string) => {
                console.warn (`ffmpeg stderr [${ce.name}]: ${data}`)
                cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `StdErr: ${data}`} as ProcessInfo
            })
            ffmpeg.on('error', async (error: Error) => { 
                console.warn (`ffmpeg on-error [${ce.name}]: ${error.name}: ${error.message}`)
                cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `Error: ${error.name}: ${error.message}`} as ProcessInfo
            })

            ffmpeg.on('close', async (code: number) => {
                console.warn ((new Date()).toTimeString().substring(0,8) + ` ffmpeg on-close [${ce.name}]: code=${code}`)
                cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process as ProcessInfo, taskid: null, running: false, error: code !== 0, check_after: Date.now()};
            });
        }

        
    } catch (e) {
        console.warn ((new Date()).toTimeString().substring(0,8) + ` FFMpeg catch error [${ce.name}]: ${e}, try again in 1minute`)
        cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process as ProcessInfo, running: false, error: true, in_progress: false, status: e as string, check_after: Date.now() + 60000};
    }

    return  cameraCache[cameraKey].ffmpeg_process as ProcessInfo
}


const PORT = process.env['PORT'] || 8080


async function ensureDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder)
        if (!stat.isDirectory()) {
            throw new Error(`${folder} is not a directory`)
        }
        return true
    } catch (e) {
        if (e.code === 'ENOENT') {
            try {
                await fs.mkdir(folder)
                return true
            } catch (e) {
                throw new Error(`Cannot create ${folder}: ${e}`)
            }
        } else {
            throw new Error(`Cannot stat ${folder}: ${e}`)
        }
    }
}

async function init_web() {

    var assets = new Router()
        .get('/image/:moment', async (ctx, _next) => {
            const moment = ctx.params['moment']

            try {
                const m: MovementEntry = await movementdb.get(parseInt(moment))
                const c: CameraEntry = await cameradb.get(m.cameraKey)
                const serve = `${c.disk}/${c.folder}/${m.ml && m.ml.success ? 'mlimage' : 'image'}${moment}.jpg`
                const { size } = await fs.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/video/live/:cameraKey/:file', async (ctx, _next) => {
            const cameraKey = ctx.params['cameraKey'],
                  file = ctx.params['file']

            try {
                const c = await cameradb.get(cameraKey)            
                const serve = `${c.disk}/${c.folder}/${file}`
                const { size } = await fs.stat(serve)
                //console.log(`serving : ${serve}`)
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/video/:mid/:file', async (ctx, _next) => {
            const movement = ctx.params['mid'],
                  file = ctx.params['file']

            //need to cache this in memory!!
            const m: MovementEntry = await movementdb.get(parseInt(movement))
            const ce: CameraEntry = cameraCache[m.cameraKey].ce

            if (file.endsWith('.m3u8')) {

                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 1
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 1
                // need to return a segement file for the movement
                try {
                    

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${m.lhs_seg_duration_seq}
` + [...Array(Math.round(m.seconds / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
${ce.name}.${n + m.startSegment - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"

                    ctx.body = body
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `unknown movement name=${movement} message=${err.message}`)
                }
            } else if (file.endsWith('.ts')) {
                const [camera, index, suffix] = file.split('.')
                const serve = `${ce.disk}/${ce.folder}/stream${index}.${suffix}`
                //console.log(`serving : ${serve}`)
                try {
                    const { size } = await fs.stat(serve)
                    ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `message=${err.message}`)
                }
            } else {
                ctx.throw(400, `unknown file=${file}`)
            }

        }).get('/mp4/:movement', async (ctx, _next) => {
            const movement = ctx.params['movement']

            const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : -1
            const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : -1

            try {
                const m: MovementEntry = await movementdb.get(parseInt(movement))
                const ce: CameraEntry = await cameraCache[m.cameraKey].ce

                const serve = `${ce.disk}/${ce.folder}/save${movement}.mp4`

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

        }).get('/mp4old/:movement', async (ctx, _next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `./test_video/${ctx.params[0]}`
            let streamoptions: any = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await fs.stat(filepath)

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

        }).get(['/(.*)'], async (ctx, _next) => {
            const path = ctx.params[0]
            console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/settings', async (ctx, _next) => {
            console.log (`settings save -  ${JSON.stringify(ctx.request.body)}`)
            if (ctx.request.body) {
                const new_settings: Settings = ctx.request.body
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir)
                    if (!dirchk.isDirectory())  throw new Error(`${new_settings.disk_base_dir} is not a directory`)
                    await db.put('settings', new_settings)
                    settingsCache = {...settingsCache, settings: new_settings}
                    ctx.status = 201
                } catch (err) {
                    ctx.body = err
                    ctx.status = 500
                }
            } else {
                ctx.body = 'no body'
                ctx.status = 500
            }
        })
        .post('/camera/:id', async (ctx, _next) => {
            
            const cameraKey = ctx.params['id']
            console.log (`camera save ${cameraKey} -  ${JSON.stringify(ctx.request.body)}`)
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body
                const folder = `${new_ce.disk}/${new_ce.folder}`
                if (cameraKey === 'new') {
                    // creating new entry
                    try {
                        await ensureDir(folder)
                        const new_key = "C" + ((Date.now() / 1000 | 0) - 1600000000)
                        await cameradb.put(new_key, new_ce)
                        cameraCache[new_key] = {ce: new_ce }
                        ctx.status = 201
                    } catch (e) {
                        ctx.throw(400, e)
                    }
                    
                } else {

                    // updating existing camera
                    try {
                        const old_ce: CameraEntry = await cameradb.get(cameraKey)
                        if (!old_ce) throw new Error(`camera ${cameraKey} not found`)

                        await ensureDir(folder)
                        const new_vals: CameraEntry = {...old_ce, ...new_ce}
                        await cameradb.put(cameraKey, new_vals) 
                        cameraCache[cameraKey].ce = new_vals
                        ctx.status = 201
   
                    } catch (e) {
                        console.warn (e)
                        ctx.throw(400, e)
                    }

                }
            } else {
                ctx.status = 500
            }
        }).post('/movements/:id', async (ctx, _next) => {
            const cid = ctx.params['camera']
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: any = ctx.request.body
                const cmd = confirmed.map((m: any) => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
        }).get('/movements', async (ctx, _next) => {

            const cameras: CameraEntryClient[] = Object.keys(cameraCache).map((key) => {

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
                const local_video = await fs.readdir(`${c.disk}/${c.folder}`)
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
                const {ctimeMs} = await fs.stat (`${c.disk}/${c.folder}/stream${first_seq_on_disk}.ts`)
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
            ctx.body = await new Promise(async (res, _rej) => {
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
                        res(JSON.stringify({ config: settingsCache, cameras, movements }))
                    })
            })

        })

    const nav = new Router()
        .get('/live', async (ctx, _next) => {
            ctx.redirect(`http://${process.env['CAMERA_IP']}`)
        })
        .get('/network', async (ctx, _next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3998`)
        })
        .get('/metrics', async (ctx, _next) => {
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
    await new Promise((res, _rej) => {
        cameradb.createReadStream()
            .on('data', (data) => {
                const { key, value } = data as {key: number, value: CameraEntry}
                cameraCache[key] = {ce: value}
            })
            .on('end', () => {
                res(0)
            })
    })

    settingsCache = {settings: { disk_base_dir: '',  enable_cleanup: false, darknetDir:'', enable_ml: false, cleanup_interval: 120, cleanup_capacity: 99}, status: {}}
    try {
        settingsCache = {...settingsCache, settings : await db.get('settings') as Settings}
    } catch (e) {
        console.warn ('no settings defined yet')
    }

    let interval_until_next_delete = 0
    async function controll_loop() {
        for (let cid of Object.keys(cameraCache)) {
 
            const pi = await StreamingController(cid)
            if (pi?.running) {
                await processMovement(cid, jobman)

                if (interval_until_next_delete <= 0) {

                    let settings : Settings = settingsCache.settings

                    if (settings.enable_cleanup && settings.disk_base_dir) {
                        diskCheck(settings.disk_base_dir, Object.keys(cameraCache).filter(c => cameraCache[c].ce.enable_streaming).map(c => `${settings.disk_base_dir}/${cameraCache[c].ce.folder}`), settings.cleanup_capacity).then(status => settingsCache = {...settingsCache, status: {...status, checked: new Date()}})
                    }
                    interval_until_next_delete = settingsCache.settings.cleanup_interval
                } else {
                    interval_until_next_delete--
                    settingsCache = {...settingsCache, status: {...settingsCache.status, nextCheckInSeconds: interval_until_next_delete}}
                }
            }
        }
    }

    // Start the Polling process
    setInterval(controll_loop, 1000)

    init_web()

    //db.close()
}

main()
