const
    assert = require('assert'),
    Koa = require('koa'),
    send = require('koa-send'),
    fs = require('fs'),
    path = require('path'),
    lexint = require('lexicographic-integer'),
    leveldown = require('leveldown')

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
    startDate: Date;
    startSegment: number;
    lhs_seg_duration_seq: number;
    seconds: number;
    consecutivesecondswithout: number;
}

var spawn = require('child_process').spawn;

async function init_movement_poll(db: LevelUp, movementdb: LevelUp, camera_name: string) {


    const jobman = new JobManager(db, 1, async function (seq: number, d: JobData): Promise<JobReturn> {

        let newJob: JobData | null = null
        if (d.task === JobTask.ML) {

            const m = await movementdb.get(d.movement_key)
            const input = `${VIDEO_PATH}/${camera_name}/image${d.movement_key}.jpg`
            await new Promise((acc, rej) => {
                let stdout = ''
                var ml = spawn('/bin/ls', ['-l', input]);

                ml.stdout.on('data', (data: string) => {
                    stdout += data
                    console.log(`ml stdout: ${data}`);
                })

                ml.stderr.on('data', (data: string) => {
                    stdout += data
                    console.error(`ml stderr: ${data}`);
                });

                ml.on('close', async (code: number) => {
                    if (code === 0) {
                        await movementdb.put(d.movement_key, { ...m, ml: { success: true, tags: ["test"] } })
                    } else {
                        await movementdb.put(d.movement_key, { ...m, ml: { success: false, stdout } })
                    }
                    acc(code)
                });

            })
            return { seq, status: JobStatus.Success }

        } else if (d.task === JobTask.Snapshot) {

            const m = await movementdb.get(d.movement_key)
            newJob = await new Promise((acc, rej) => {
                let newJob: JobData
                var ffmpeg = spawn('/usr/bin/ffmpeg', ['-ss', '0', '-i', `${VIDEO_PATH}/${camera_name}/stream${(m.startSegment + 2)}.ts`, '-vframes', '1', '-q:v', '2', `${VIDEO_PATH}/${camera_name}/image${d.movement_key}.jpg`]);
                let stdout = ''
                ffmpeg.stdout.on('data', (data: string) => {
                    stdout += data
                    console.log(`ffmpeg stdout: ${data}`);
                })

                ffmpeg.stderr.on('data', (data: string) => {
                    stdout += data
                    console.error(`ffmpeg stderr: ${data}`);
                });

                ffmpeg.on('close', async (code: number) => {
                    if (code === 0) {
                        await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: true } })
                        newJob = { task: JobTask.ML, movement_key: d.movement_key }
                    } else {
                        await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: false, stdout } })
                        //rej(`ffmpeg process exited with code ${code}`)
                    }
                    acc(newJob)
                });
            })
        }
        return { seq, status: JobStatus.Success, ...(newJob && { newJob }) }
    })
    jobman.start(false)

    const SECS_WITHOUT_MOVEMENT = 10

    const re = new RegExp(`stream([\\d]+).ts`, 'g');
    //await fs.promises.mkdir(movdir, { recursive: true })

    let movement_entry: MovementEntry
    async function processMovement() {
        try {
            const body_json = await server_fetch(`http://${process.env.CAMERA_IP}/api.cgi?cmd=GetMdState&user=admin&password=${process.env.CAMERA_PASSWD}`)
            const body = JSON.parse(body_json)
            //console.log(body[0].value)
            if (body[0].value.state === 1) {
                console.log(`got movement`)
                if (!movement_entry) {
                    // get the current segment that will contain the movement

                    const filepath = `${VIDEO_PATH}/${camera_name}/stream.m3u8`
                    const hls = (await fs.promises.readFile(filepath)).toString()

                    const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                    const lhs_seg_duration_seq = hls.match(/#EXT-X-TARGETDURATION:([\d])/)[1]
                    movement_entry = {
                        startDate: new Date(),
                        startSegment: parseInt(hls_segments[hls_segments.length - 1]),
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
                    if (movement_entry.consecutivesecondswithout > SECS_WITHOUT_MOVEMENT) {
                        //const filename = `${movdir}/${process.env.CAMERA_NAME}-${movement_entry.startDate.getFullYear()}-${('0' + (movement_entry.startDate.getMonth() + 1)).slice(-2)}-${('0' + movement_entry.startDate.getDate()).slice(-2)}.csv`
                        console.log(`writing movement`)
                        const movement_key = (movement_entry.startDate.getTime() / 1000 | 0) - 1600000000
                        await movementdb.put(movement_key, movement_entry)
                        //await fs.promises.appendFile(filename, `${movement_entry.startDate.toISOString()};${movement_entry.seconds}` + "\n")

                        await jobman.submit({ task: JobTask.Snapshot, movement_key })
                        movement_entry = null

                    } else {
                        console.log(`no movement`)
                        movement_entry.consecutivesecondswithout++
                    }
                }
            }
        } catch (e) {
            console.error(e)
        }
    }

    setInterval(processMovement, 1000)
}


async function init_web(movementdb: LevelUp) {

    var assets = new Router()
        .get('/image/:camera/:moment', async (ctx, next) => {
            const camera_name = ctx.params.camera
            const moment = ctx.params.moment
            //const { startSegment, lhs_seg_duration_seq, seconds } = await movementdb.get(parseInt(moment))
            try {
                const serve = `${VIDEO_PATH}/${camera_name}/image${moment}.jpg`
                const { size } = await fs.promises.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = fs.createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
            } catch (e) {
                ctx.throw(`error e=${JSON.stringify(e)}`)
            }

        })
        .get('/video/:camera/:moment/:file', async (ctx, next) => {
            const camera_name = ctx.params.camera
            const moment = ctx.params.moment
            const file = ctx.params.file

            console.log(`camera_name=${camera_name} moment=${moment} file=${file}`)

            if (moment === 'live') {
                const serve = `${VIDEO_PATH}/${camera_name}/${file}`
                console.log(`serving : ${serve}`)
                ctx.body = fs.createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
            } else if (!isNaN(moment)) {

                if (file.endsWith('.m3u8')) {
                    // need to return a segement file for the movement
                    const { startSegment, lhs_seg_duration_seq, seconds } = await movementdb.get(parseInt(moment))
                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${lhs_seg_duration_seq}
` + [...Array(seconds + 3).keys()].map(n => `#EXTINF:2.000000,
stream${n + startSegment}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"

                    ctx.body = body
                } else if (file.endsWith('.ts')) {
                    const serve = `${VIDEO_PATH}/${camera_name}/${file}`
                    console.log(`serving : ${serve}`)
                    try {
                        const { size } = await fs.promises.stat(serve)
                        ctx.body = fs.createReadStream(serve, { encoding: null }).on('error', ctx.onerror)
                    } catch (e) {
                        ctx.throw(`error e=${JSON.stringify(e)}`)
                    }
                } else {
                    ctx.throw(`unknown file=${file}`)
                }
            } else {
                ctx.throw(`unknown moment=${moment}`)
            }

        }).get(['/mp4/(.*)'], async (ctx, next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `${VIDEO_PATH}/${ctx.params[0]}`
            let streamoptions: any = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await fs.promises.stat(filepath)

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
            ctx.body = fs.createReadStream(filepath, streamoptions).on('error', ctx.onerror)
            //ctx.body = fs.createReadStream(filepath, { encoding: null, start, end }).on('error', ctx.onerror).pipe(PassThrough());

        }).get(['/(.*)'], async (ctx, next) => {
            const path = ctx.params[0]
            console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: './build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/movements/:camera', async (ctx, next) => {
            const camera = ctx.params.camera
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: { movement_key: number }[] = ctx.request.body
                const cmd = confirmed.map(m => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
        }).get('/movements/:camera', async (ctx, next) => {
            const camera = ctx.params.camera
            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res, rej) => {
                let runningKeys: MovementEntry[] = []

                let first_seq_on_disk = 0
                const local_video = await fs.promises.readdir(`${VIDEO_PATH}/${camera}`)
                const local_video_re = new RegExp(`^stream(\\d+).ts`)
                for (let dir_entry of local_video) {
                    const entry_match = dir_entry.match(local_video_re)
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

                // Everything in the _queue with a sequence# < nextToRun should be running (all completed will have been deleted)
                const feed = movementdb.createReadStream({ reverse: true }).on('data', ({ key, value }) => {
                    if (value.startSegment >= first_seq_on_disk) {
                        runningKeys.push({ ...value, movement_key: key, startDate: (new Date(value.startDate)).toUTCString().replace(/ \d{4}/, "").replace(/ GMT$/, "") })
                    }
                }).on('end', () => {
                    res(JSON.stringify(runningKeys))
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
    const db = level(leveldown('./mydb'))

    const movementdb = sub(db, 'movements', {
        keyEncoding: {
            type: 'lexicographic-integer',
            encode: (n) => lexint.pack(n, 'hex'),
            decode: lexint.unpack,
            buffer: false
        }, valueEncoding: 'json'
    })
    //await movementdb.clear()
    init_movement_poll(db, movementdb, process.env.CAMERA_NAME)
    init_web(movementdb)

    //db.close()
}

main()
