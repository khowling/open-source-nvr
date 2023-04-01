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
import { catalogVideo, diskCheck, DiskCheckReturn } from './diskcheck.js'

import { JobManager, JobStatus, JobReturn, JobData, JobTask } from './jobmanager.js'

interface Settings {
    disk_base_dir: string;
    cleanup_interval: number;
    cleanup_capacity: number;
    enable_ml: boolean;
    mlDir: string;
    mlCmd: string;
    labels: string;
}
interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number;
    lhs_seg_duration_seq?: number;
    seconds: number;
    consecutivesecondswithout: number;
    ml?: MLData;
    ml_movejpg?: SpawnData;
    ffmpeg?: SpawnData;
}

interface MovementToClient {
    key: number;
    movement: MovementEntry;
    startDate_en_GB: string;
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
    delete: boolean;
    name: string;
    folder: string;
    disk: string;
    ip?: string;
    passwd?: string;
    enable_streaming: boolean;
    enable_movement: boolean;
    secWithoutMovement: number;
    secMaxSingleMovement: number;
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

interface MovementStatus {
    in_progress: boolean;
    fail: boolean;
    check_after?: number;
    status?: string;
    current_movement?: MovementEntry | null;
}

interface CameraEntryClient extends CameraEntry {
    key: string
    ffmpeg_process?: ProcessInfo;
    movementStatus?: MovementStatus;
}

interface CameraCacheEntry {
    ce: CameraEntry;
    ffmpeg_process?: ProcessInfo;
    movementStatus?: MovementStatus;
}

interface CameraCache { 
    [key: string]: CameraCacheEntry;
}
var cameraCache: CameraCache = {}

interface SettingsCache {
    settings: Settings;
    status: SettingsStatus;
}

interface SettingsStatus { 
    nextCheckInMinutes: number;
    lastChecked?: Date;
    fail: boolean;
    error?: string;
}

var settingsCache: SettingsCache 


import { ChildProcessWithoutNullStreams, spawn} from 'child_process'
import { clearScreenDown } from 'readline'

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
        let new_movement: MovementEntry = {...m}
        const c = cameraCache[m.cameraKey].ce
        const input = `${c.disk}/${c.folder}/image${d.movement_key}.jpg`
        const outpic = `${c.disk}/${c.folder}/mlimage${d.movement_key}.jpg`
        await new Promise((acc, _rej) => {
            let ml_stdout = '', ml_stderr = '', ml_error = ''
            // './darknet', ['detect', 'cfg/yolov3.cfg', 'cfg/yolov3.weights', input]
            let [cmd, ...rest] = settingsCache.settings.mlCmd.split(' ')
            const ml_task = spawn(cmd, rest.map(a => a === '{in}' ? input : a === '{out}' ? outpic : a), { cwd: settingsCache.settings.mlDir, timeout: 120000 });

            ml_task.stdout.on('data', (data: string) => { ml_stdout += data })
            ml_task.stderr.on('data', (data: string) => { ml_stderr += data })
            ml_task.on('error', async (error: Error) => { ml_error = `${error.name}: ${error.message}` })

            // The 'close' event will always emit after 'exit' was already emitted, or 'error' if the child failed to spawn.
            ml_task.on('close', async (ml_code: number) => {
                const ml_succcess = ml_code === 0
                const ml: MLData = { success: ml_succcess, code: ml_code, ...(!ml_succcess && {stderr: ml_stderr}), stdout: ml_stdout, error: ml_error, tags: [] }
                new_movement = {...new_movement, ml}

                if (ml_succcess) {
                    let mltags = ml_stdout.match(/[\w ]+: [\d]+%/g)
                    const tags = mltags? mltags.map(d => { let c = d.match(/([\w ]+): ([\d]+)%/); return { tag: c[1], probability: parseInt(c[2])}}) : []
                    new_movement = {...new_movement, ml: {...ml, tags}}
                    await movementdb.put(d.movement_key, new_movement)

                    //let mv_stdout = '', mv_stderr = '', mv_error = ''
                    //const mv_task = spawn('/usr/bin/mv', [`${settingsCache.settings.mlDir}/predictions.jpg`, outpic], { timeout: 5000 })

                    //mv_task.stdout.on('data', (data: string) => { mv_stdout += data })
                    //mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
                    //mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

                    //mv_task.on('close', async (mv_code: number) => {
                    //    const mv_succcess = mv_code === 0
                    //    await movementdb.put(d.movement_key, { ...new_movement, ml_movejpg: { success: mv_succcess, ...(!mv_succcess && {stderr: mv_stderr, stdout: mv_stdout, error: mv_error }) }})
                        acc(0)


                } else {
                    await movementdb.put(d.movement_key, new_movement)
                    acc(ml_code)
                }

            });

        })

    } else if (d.task === JobTask.Snapshot) {
        // Take a single frame snapshot to corispond to the start of the movement segment recorded in startSegment.
        // -ss seek to the first frame in the segment file

        const m: MovementEntry = await movementdb.get(d.movement_key)
        const c = cameraCache[m.cameraKey].ce

        const code = await new Promise((acc, _rej) => {

            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-y', '-ss', '0', '-i', `${c.disk}/${c.folder}/stream${(m.startSegment + 1)}.ts`, '-hide_banner', '-loglevel', 'error', '-frames:v', '1', '-q:v', '2', `${c.disk}/${c.folder}/image${d.movement_key}.jpg`], { timeout: 120000 });
            let ff_stdout = '', ff_stderr = '', ff_error = ''

            ffmpeg.stdout.on('data', (data: string) => { ff_stdout += data })
            ffmpeg.stderr.on('data', (data: string) => { ff_stderr += data })
            ffmpeg.on('error', async (error: Error) => { ff_error = `${error.name}: ${error.message}` })

            ffmpeg.on('close', async (ff_code: number) => {
                const ff_succcess = ff_code === 0
                await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: ff_succcess, ...(!ff_succcess && {stderr: ff_stderr, stdout: ff_stdout, error: ff_error })} })
                if (ff_succcess && settingsCache.settings.enable_ml) {
                    newJob = { task: JobTask.ML, movement_key: d.movement_key }
                }
                acc(ff_code)
            });
        })
    }
    return { seq, status: JobStatus.Success, ...(newJob ? { newJob } : {}) }
}


const re = new RegExp(`stream([\\d]+).ts`, 'g');

 // Called every seond for each camera, to process movement
async function processMovement(cameraKey: string, jobManager: JobManager) : Promise<void> {

    const { movementStatus, ce } = cameraCache[cameraKey]
    // curcuit breaker, if movement error recorded from API, dont try again, until after check_after!
    if (movementStatus?.in_progress || (movementStatus?.fail && ( (!movementStatus.check_after) || movementStatus.check_after > Date.now())) ) {
            return
    }

    // prevent multiple movement processes from running at the same time (needed with setInterval)
    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...cameraCache[cameraKey].movementStatus, in_progress: true}}

    const {ip, passwd, disk, folder, secWithoutMovement, secMaxSingleMovement} = ce
    try {

        const current_movement = movementStatus?.current_movement

        const body_json = await server_fetch(`http://${ip}/api.cgi?cmd=GetMdState&user=admin&password=${passwd}`, {timeout: 2000})

        // camera content type response is "text/html" even though its json :)
        const body = JSON.parse(body_json)
        //console.log(body[0].value)
        if (body[0].error) {
            cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {fail: true, in_progress: false, status: `fetch movement error: ${JSON.stringify(body)}`, check_after: Date.now() + (30 * 1000)}}
        } else if (body[0].value.state === 1) {
            // Got movement (state ===1)
            if (!current_movement) {
                // got NEW movement
                console.log(`processMovement: Got NEW movement (${cameraCache[cameraKey].ce.name})`)

                // Need to determine the segment that corrisponds to the movement
                // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${disk}/${folder}/stream.m3u8`
                const hls = (await fs.readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {
                    in_progress: false, fail: false, status: "new movement detected",
                    current_movement: {
                        cameraKey,
                        startDate: Date.now(),
                        startSegment: parseInt(hls_segments[hls_segments.length - 1]) + 1,
                        lhs_seg_duration_seq,
                        seconds: 1,
                        consecutivesecondswithout: 0
                    }
                }}
            } else {
                // continuatation of same movment event
                console.log(`processMovement: continuatation movement (${cameraCache[cameraKey].ce.name}) (${current_movement.seconds + 1 + current_movement.consecutivesecondswithout}s)`)

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {
                    ...movementStatus,
                    in_progress: false, fail: false, status: "continuatation of same movment event",
                    current_movement: {
                        ...movementStatus.current_movement,
                        seconds: current_movement.seconds + 1 + current_movement.consecutivesecondswithout,
                        consecutivesecondswithout: 0
                    }
                }}
            }
        } else {
            // no movement from camera
            if (current_movement) {
                // got current movement
                if (current_movement.consecutivesecondswithout > secWithoutMovement || current_movement.seconds > (secMaxSingleMovement || 600)) {

                    console.log(`processMovement:  movement complete (${cameraCache[cameraKey].ce.name}) (${current_movement.seconds}s)`)

                    // no movement for too long, end movement and queue Job for Image processing
                    const movement_key = (current_movement.startDate / 1000 | 0) - 1600000000
                    await movementdb.put(movement_key, current_movement)

                    await jobManager.submit({ task: JobTask.Snapshot, movement_key })

                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                        in_progress: false, fail: false, status: "movement ended, recorded to database key=${movement_key}",
                    }}

                } else {
                    // still same movement, incremenet consecutive seconds without movement
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                        ...movementStatus,
                        in_progress: false, fail: false, status: "continuatation of same movment event (within consecutivesecondswithout)",
                        current_movement: {
                            ...movementStatus.current_movement,
                            consecutivesecondswithout: current_movement.consecutivesecondswithout + 1
                    }}}
                }
            } else {
                cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                    ...movementStatus,
                    in_progress: false, fail: false, status: "no current movement"
                }}
            }
        }
    } catch (e) {
        const filtersensitive = e?.message ? e.message.replaceAll(passwd, "****").replaceAll(ip, "****") : e
        console.warn (`${new Date()}: processMovement failed error: cameraKey=${cameraKey}, name=${cameraCache[cameraKey]?.ce?.name}  message=${filtersensitive}`)
        cameraCache[cameraKey] = { ...cameraCache[cameraKey],  movementStatus: {
            ...movementStatus, 
            fail: true, in_progress: false,
            check_after: Date.now() + (30 * 1000),
            status: filtersensitive}}
        //console.error(e)
    }
}

// run every second to start new cameras, and ensure steaming is working for running cameras
async function StreamingController(cameraKey: string): Promise<ProcessInfo | undefined> {
    //console.log (`StreamingController for ${cameraKey}`)
    const { ce, ffmpeg_process } = cameraCache[cameraKey]
    const streamFile = `${ce.disk}/${ce.folder}/stream.m3u8`


    // chkecFFMpeg still running from last interval, skip this check.
    // Protects duplicate running if this function takes longer than 1 second
    if (ffmpeg_process?.in_progress) {
        return ffmpeg_process
    }

    // No streaming enabled, and processes is running then kill it
    if (!ce.enable_streaming) {
        if (ffmpeg_process?.running) {
            ffmpeg_process.taskid?.kill();
        }
        return ffmpeg_process
    }

    // check if ffmpeg has stopped, or has shopped producing output
    if (ffmpeg_process) {
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (ffmpeg_process.check_after && ffmpeg_process.check_after < Date.now())   {
            
            if (ffmpeg_process.running) {
                console.log (`Checking ffmpeg for [${ce.name}] running=${ffmpeg_process.running} error=${ffmpeg_process.error}...`)
                try {
                    const {mtimeMs} = await fs.stat(streamFile),
                           last_updated_ago = Date.now() - mtimeMs
                    if (last_updated_ago > 10000 /* 10 seconds */) {
                        console.warn (`ffmpeg no output for 10secs for ${ce.name} - file ${streamFile}, kill process`)
                        // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                        ffmpeg_process.taskid?.kill();
                    } else {
                        // its running fine, recheck in 30secs
                        console.log (`Checking ffmpeg for [${ce.name}], all good, last_updated_ago=${last_updated_ago}mS, check again in 1minute`)
                        cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process as ProcessInfo, check_after: Date.now() + 60000}
                    }
                } catch (e) {
                    console.warn (`cannot access ffmpeg output for ${ce.name} - file ${streamFile}, kill process`)
                    // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                    ffmpeg_process.taskid?.kill();
                }

                return cameraCache[cameraKey].ffmpeg_process as ProcessInfo

            } else {
                console.warn (`Try to restart failed or stopped ffmpeg for [${ce.name}] running=${ffmpeg_process.running} error=${ffmpeg_process.error}`)
            }
        } else {
            // not time to re-check, just leave it
            return ffmpeg_process
        }
    }

    // start ffmpeg
    try {
        console.log ((new Date()).toTimeString().substring(0,8) + ` Getting token for [${ce.name}]...`)
        cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: null, running: false, error: false, in_progress: true, status: 'Getting token'}}
        
        const body_json = await server_fetch(`http://${ce.ip}/cgi-bin/api.cgi?cmd=Login&token=null`, {timeout: 5000}, [{"cmd":"Login","action":0,"param":{"User":{"userName":"admin","password": ce.passwd}}}])
        const body = JSON.parse(body_json)
        if (body[0].error) {
            cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: null, running: false, error: true, in_progress: false, status: `Unable to retrive token: ${JSON.stringify(body[0])}`, check_after: Date.now() + 60000}}
        } else {
            const token = body[0].value.Token.name
            console.log ((new Date()).toTimeString().substring(0,8) + ` starting ffmpeg for [${ce.name}] : ${streamFile}...`)
            var ffmpeg : ChildProcessWithoutNullStreams = spawn('/usr/bin/ffmpeg', ['-r', '25', '-i', `rtmp://admin:${ce.passwd}@${ce.ip}/bcs/channel0_main.bcs?token=${token}&channel=0&stream=0`, '-hide_banner', '-loglevel', 'error', '-vcodec', 'copy', '-start_number', ((Date.now() / 1000 | 0) - 1600000000).toString(), streamFile ])
            cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: ffmpeg, running: true, error: false, in_progress: false, status: 'Starting...\n', check_after: Date.now() + 60000 /* check it hasn't hung every 30seconds */}}


            ffmpeg.stdout.on('data', (data: string) => {
                console.log (`ffmpeg stdout [${ce.name}]: ${data}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + data.toString()} as ProcessInfo}
            })
            ffmpeg.stderr.on('data', (data: string) => {
                console.warn (`ffmpeg stderr [${ce.name}]: ${data}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `StdErr: ${data}`} as ProcessInfo}
            })
            ffmpeg.on('error', async (error: Error) => { 
                console.warn (`ffmpeg on-error [${ce.name}]: ${error.name}: ${error.message}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `Error: ${error.name}: ${error.message}`} as ProcessInfo}
            })

            ffmpeg.on('close', async (code: number) => {
                console.warn ((new Date()).toTimeString().substring(0,8) + ` ffmpeg on-close [${ce.name}]: code=${code}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, taskid: null, running: false, error: code !== 0, check_after: Date.now()}}
            });
        }

        
    } catch (e) {
        console.warn ((new Date()).toTimeString().substring(0,8) + ` FFMpeg catch error [${ce.name}]: ${e}, try again in 1minute`)
        cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, running: false, error: true, in_progress: false, status: e?.message, check_after: Date.now() + 60000}}
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
        .get('/video/:startSegment/:seconds/:cameraKey/:file', async (ctx, _next) => {
            const 
                startSegment = ctx.params['startSegment'],
                seconds = ctx.params['seconds'],
                cameraKey = ctx.params['cameraKey'],
                file = ctx.params['file']

            const ce: CameraEntry = cameraCache[cameraKey].ce
            
            if (file.endsWith('.m3u8')) {
                const segmentInt = parseInt(startSegment)//.getTime()
                const secondsInt = parseInt(seconds)//.getTime()
                if (isNaN(segmentInt) || isNaN(secondsInt) ) {
                    ctx.throw(400, `message=${startSegment} or ${seconds} not valid values`)
                } else {
                    //const startSegment = segment // (d / 1000 | 0) - 1600000000
                    const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0
                    const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
` + [...Array(Math.round(secondsInt / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"
    
                    ctx.body = body
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${ce.disk}/${ce.folder}/${file}`
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
        })
        /*
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

        })
        */
        .get('/mp4/:startSegment/:seconds/:cameraKey', async (ctx, _next) => {
            const 
                startSegment = ctx.params['startSegment'],
                seconds = ctx.params['seconds'],
                cameraKey = ctx.params['cameraKey']

            try {
                const ce: CameraEntry = await cameraCache[cameraKey].ce

                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0
                const serve = `${ce.disk}/${ce.folder}/save${startSegment}-${seconds}.mp4`

                await new Promise(async (res, rej) => {
                    const mv_task = spawn('/usr/bin/ffmpeg', ['-y', '-i', `http://localhost:${PORT}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${preseq > 0 || postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve], { timeout: 50000 })
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

        })
        /*
        .get('/mp4/:movement', async (ctx, _next) => {
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

        })
        */
        /*
        .get('/mp4old/:movement', async (ctx, _next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `./test_video/${ctx.params[0]}`
            let streamoptions: any = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await fs.stat(filepath)

                const [range_start, range_end] = ctx.headers.range.replace(/bytes=/, "").split("-"),
                    start = parseInt(range_start, 10),
                    chunklength = range_end ? parseInt(range_end, 10) - start + 1 : Math.min(1024 * 1024 * 32 / * 32KB default * /, size - start / * whats left in the file  * /),
                    end = start + chunklength - 1

                console.log(`serving video request range: ${range_start} -> ${range_end},  providing ${start} -> ${end} / ${size}`)

                ctx.set('Accept-Ranges', 'bytes');
                ctx.set('Content-Length', chunklength.toString()) // 38245154
                ctx.set('Content-Range', `bytes ${start}-${end}/${size}`) // bytes 29556736-67801889/67801890

                streamoptions = { ...streamoptions, start, end }
                ctx.status = 206;
            }
            ctx.body = createReadStream(filepath, streamoptions).on('error', ctx.onerror)

        })
        */
        .get(['/(.*)'], async (ctx, _next) => {
            const path = ctx.params[0]
            console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/settings', async (ctx, _next) => {
            console.log (`settings save -  ${JSON.stringify(ctx.request.body)}`)
            if (ctx.request.body) {
                const new_settings: Settings = ctx.request.body as Settings
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir)
                    if (!dirchk.isDirectory())  throw new Error(`${new_settings.disk_base_dir} is not a directory`)
                    await db.put('settings', new_settings)
                    settingsCache = {...settingsCache, settings: new_settings, status: {...settingsCache.status, nextCheckInMinutes:  new_settings.cleanup_interval }}
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
            const deleteOption = ctx.request.query['delopt']

            console.log (`camera save ${cameraKey} -  ${JSON.stringify(ctx.request.body)}`)
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body as CameraEntry
                const folder = `${new_ce.disk}/${new_ce.folder}`
                if (cameraKey === 'new') {
                    // creating new entry
                    try {
                        await ensureDir(folder)
                        const new_key = "C" + ((Date.now() / 1000 | 0) - 1600000000)
                        await cameradb.put(new_key, {delete: false, ...new_ce} as CameraEntry)
                        cameraCache[new_key] = {ce: new_ce }
                        ctx.status = 201
                    } catch (e) {
                        ctx.throw(400, e)
                    }
                    
                } else {

                    // updating existing camera
                    try {
                        const old_cc: CameraCacheEntry = cameraCache[cameraKey] 
                        if (!old_cc) throw new Error(`camera ${cameraKey} not found`)

                        if (!deleteOption) {
                            await ensureDir(folder)
                        }

                        // stop old camera definition movements and ffmpeg
                        if (old_cc.ffmpeg_process?.running) {
                            cameraCache[cameraKey] = {
                                ce: {...old_cc.ce, enable_streaming: false},
                                ffmpeg_process: null,
                                movementStatus: null
                            }
                            old_cc.ffmpeg_process.taskid?.kill();
                        }

                        if (!deleteOption) {
                            const new_vals: CameraEntry = {...old_cc.ce, ...new_ce}
                            await cameradb.put(cameraKey, new_vals) 
                            cameraCache[cameraKey] = { ce: new_vals }
                            ctx.status = 201
                        } else {
                            if (deleteOption === 'delall') {
                                //delete all camera files
                                const diskres = await clearDownDisk(settingsCache.settings.disk_base_dir, [cameraKey], -1)
                            }
                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                //delete camera entry
                                const new_vals: CameraEntry = {...old_cc.ce, delete: true}

                                await cameradb.put(cameraKey, new_vals) 
                                cameraCache[cameraKey] = { ce: new_vals }
                                ctx.status = 200
                            }
                        }
   
                    } catch (e) {
                        console.warn (e)
                        ctx.throw(400, e)
                    }

                }
            } else {
                ctx.status = 500
            }
            /*
        }).post('/movements/:id', async (ctx, _next) => {
            const cid = ctx.params['camera']
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: any = ctx.request.body
                const cmd = confirmed.map((m: any) => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
            */
        }).get('/movements', async (ctx, _next) => {
            const mode = ctx.query['mode'] 
            const cameras: CameraEntryClient[] = Object.keys(cameraCache).filter(c => !cameraCache[c].ce.delete).map((key) => {

                const c = cameraCache[key]
                const {ce, ffmpeg_process, movementStatus} = c
                // filer out data not for the client
                const {ip, passwd, ...cameraEntry} = ce
                //const {current_movement, ...movement} = c.movement || {}
                const {taskid, ...ffmpeg_process_wo_task} = ffmpeg_process || {}
                return {key, ...cameraEntry, ffmpeg_process: ffmpeg_process_wo_task, movementStatus} as CameraEntryClient
            })

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res, _rej) => {

                let movements: MovementToClient[] = []

                if (mode === "Time") {

                    for (let c of cameras) {
                        const listfiles = await catalogVideo(`${c.disk}/${c.folder}`)
                        for (let i = listfiles.length - 1; i >= 0; i--) {
                            const segs = listfiles[i]
                            movements.push({
                                key: parseInt(c.key.slice(1) + segs.segmentStart),
                                startDate_en_GB: segs.startDate_en_GB,
                                movement: {
                                    cameraKey: c.key,
                                    startDate: segs.ctimeMs,
                                    startSegment: segs.segmentStart,
                                    seconds: segs.seconds,
                                    consecutivesecondswithout: 0
                                }
                            })
                        }
                    }
                    res({ config: settingsCache, cameras, movements })
                } else {
                    

                    // Everything in movementdb, with key time (movement start date) greater than the creation date of the oldest sequence file on disk
                    const feed = movementdb.createReadStream({ reverse: true /*, limit: 100*/ /*, gt: oldestctimeMs > 0 ? (oldestctimeMs / 1000 | 0) - 1600000000 : 0 */})
                        .on('data', (data) => {
                            const { key, value } = data as {key: number, value: MovementEntry}
                            const { ml, cameraKey } = value

                            let tags = ml?.success ? ml.tags : null
                            if (mode === 'Filtered') {
                                if (tags && Array.isArray(tags) && tags.length > 0) {
                                    const { ignore_tags } = cameraCache[cameraKey]?.ce || {}
                                    if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
                                        tags = tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
                                    } 
                                }
                            }
                            if (mode === 'Movement' || (mode === 'Filtered' && tags?.length >0)) {
                                const startDate = new Date(value.startDate)
                                movements.push({
                                    key,
                                    startDate_en_GB: new Intl.DateTimeFormat('en-GB', { ...(startDate.toDateString() !== (new Date()).toDateString() && {weekday: "short"}), minute: "2-digit", hour: "2-digit",  hour12: true }).format(startDate),
                                    movement: {...value, ...(tags &&  { ml: { ...value.ml, tags}})}
                                })
                            }
                        }).on('end', () => {
                            res({ config: settingsCache, cameras, movements })
                        })
                }
            })

        })

    const nav = new Router()
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

    console.log(`Starting on 8080..`)
    app.listen(8080)
}


async function clearDownDisk(diskDir: string, cameraKeys : Array<string>, cleanupCapacity: number) : Promise<DiskCheckReturn> {
    const diskres = await diskCheck(diskDir, cameraKeys.map(key => `${diskDir}/${cameraCache[key].ce.folder}`), cleanupCapacity)
    console.log(diskres)
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce((acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs ? (  diskres.folderStats[cur].lastRemovedctimeMs > acc? diskres.folderStats[cur].lastRemovedctimeMs : acc ) : acc ,0)
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            const keytoDeleteTo =  cleanupCapacity === -1 ? null : (mostRecentctimMs / 1000 | 0) - 1600000000
            const deleteKeys : Array<number> = await new Promise((res, _rej) => {
                let keys : Array<number> = []
                movementdb.createReadStream(keytoDeleteTo && {lte: keytoDeleteTo})
                .on('data', (data) => {
                    const { key, value } = data as {key: number, value: MovementEntry}
                    if (cameraKeys.includes(value.cameraKey)) {  
                        keys.push(key) 
                    }})
                .on('end', () => {
                    res(keys)
                })
            })

            if (deleteKeys.length > 0) {
                console.log(`deleting ${deleteKeys.length} keys from movementdb`)
                await movementdb.batch([...deleteKeys.map(k => { return {type: 'del', key: k} })] as any)
            }

        }
    }
    return diskres
}

async function main() {

    const jobman = new JobManager(db, 1, jobWorker)
    jobman.start(false)

    // Populate cameraCache
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

    // Populate settingsCache
    settingsCache = {settings: { disk_base_dir: '', mlDir:'', mlCmd:'', enable_ml: false, labels: '', cleanup_interval: 0, cleanup_capacity: 90}, status: { fail: false, nextCheckInMinutes: 0}}
    try {
        settingsCache = {...settingsCache, settings : await db.get('settings') as Settings}
    } catch (e) {
        console.warn ('no settings defined yet')
    }

    // Start the Camera controll loop (ensuring ffmpeg is running, and checking movement) ()
    setInterval(async () => {
        for (let cKey of Object.keys(cameraCache)) {
            if (!cameraCache[cKey].ce.delete) {
                const pi = await StreamingController(cKey)
                if (pi?.running) {
                    await processMovement(cKey, jobman)
                }
            }
        }
    }, 1000)

    // Start the Disk controll loop, checking space and cleaning up disk and movements db
    setInterval(async () => {
        const { settings, status} = settingsCache

        if (status.nextCheckInMinutes === 0) {
            settingsCache = {...settingsCache, status: {...status, nextCheckInMinutes: settings.cleanup_interval}}
            if (settings.cleanup_interval > 0 && settings.disk_base_dir) {
                try {
                    const diskres = await clearDownDisk(settings.disk_base_dir, Object.keys(cameraCache).filter(c => (!cameraCache[c].ce.delete) && cameraCache[c].ce.enable_streaming), settings.cleanup_capacity )
                    settingsCache = {...settingsCache, status: {...status, fail:false, error: '',  ...diskres, lastChecked: new Date()}}
                } catch(e) {
                    console.log(`disk cleanup error`, e)
                    console.warn(e)
                    settingsCache = {...settingsCache, status: {...status, fail: true, error: e?.message, lastChecked: new Date()}}
                }
            }
        } else {
            settingsCache = {...settingsCache, status: {...status,  nextCheckInMinutes: status.nextCheckInMinutes - 1}}
        }
    }, 60000)

    init_web()

    //db.close()
}

main()
