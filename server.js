const
    assert = require('assert'),
    Koa = require('koa'),
    Router = require('koa-router'),
    send = require('koa-send'),
    fs = require('fs'),
    path = require('path'),
    app = new Koa(),
    http = require('http')



async function server_fetch(url, method = 'GET', headers = {}, body) {
    const opts = { method, headers }

    if (body) {
        opts.headers['content-length'] = Buffer.byteLength(body)
    }

    return new Promise(function (resolve, reject) {
        const req = http.request(url, opts, (res) => {

            if (res.statusCode !== 200 && res.statusCode !== 201) {
                let error = new Error(`Request Failed: Status Code: ${res.statusCode}`)
                //console.error(error.message)
                // Consume response data to free up memory
                res.resume();
                //throw new Error(error)
                reject(error)
            } else {

                // required to process binary image data into base64
                const contentType = res.headers['content-type']

                // collect the data chunks
                var strings = []
                res.on('data', function (chunk) {
                    strings.push(chunk)
                })
                res.on('end', () => {

                    if (strings.length === 0) {
                        resolve()
                    } else {

                        let body = strings.join('')
                        if (/^application\/json/.test(contentType)) {

                            try {
                                const parsedData = JSON.parse(body)
                                resolve(parsedData)
                            } catch (e) {
                                console.error(`server_fetch: ${e}`)
                                reject(new Error(e))
                            }
                        } else if (/^text\/html/.test(contentType)) {
                            return resolve(body)
                        } else if (/^image/.test(contentType)) {
                            resolve(Buffer.from(body, 'binary').toString('base64'))
                        } else {
                            reject(new Error(`Unknown content-type : ${contentType}`))
                        }
                    }
                })
            }
        }).on('error', (e) => {
            console.error(`server_fetch: ${e.message}`)
            reject(e)
        })

        if (opts.method === 'POST' || opts.method === 'PUT') {
            // Write data to request body
            req.end(body)
        } else {
            req.end()
        }

    })
}

assert(process.env.FILEPATH, "FILEPATH not set")
assert(process.env.CAMERA_NAME, "CAMERA_NAME not set")

const mp4dir = `${process.env.FILEPATH}/${process.env.CAMERA_NAME}/mp4`
const movdir = `${process.env.FILEPATH}/${process.env.CAMERA_NAME}/mov`
const webdir = `${process.env.FILEPATH}/${process.env.CAMERA_NAME}/web`



async function init_movement_poll() {

    const SECS_WITHOUT_MOVEMENT = 10

    await fs.promises.mkdir(movdir, { recursive: true })

    let movement_entry
    async function processMovement() {
        try {
            const body_json = await server_fetch(`http://${process.env.CAMERA_IP}/api.cgi?cmd=GetMdState&user=admin&password=${process.env.CAMERA_PASSWD}`)
            const body = JSON.parse(body_json)
            //console.log(body[0].value)
            if (body[0].value.state === 1) {
                console.log(`got movement`)
                if (!movement_entry) {
                    movement_entry = {
                        startDate: new Date(),
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
                        const filename = `${movdir}/${process.env.CAMERA_NAME}-${movement_entry.startDate.getFullYear()}-${('0' + (movement_entry.startDate.getMonth() + 1)).slice(-2)}-${('0' + movement_entry.startDate.getDate()).slice(-2)}.csv`
                        console.log(`writing movement ${filename}`)
                        await fs.promises.appendFile(filename, `${movement_entry.startDate.toISOString()};${movement_entry.seconds}` + "\n")
                        movement_entry = null


                        // create Snippet
                        // ffmpeg -ss 60 -t 60 -acodec copy -vcodec copy output.wmv

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


async function init_web() {

    await fs.promises.mkdir(webdir, { recursive: true })


    var static = new Router()
        .get(['/video/(.*)'], async (ctx, next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `${mp4dir}/${ctx.params[0]}`
            let streamoptions = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await fs.promises.stat(filepath)

                const [range_start, range_end] = ctx.headers.range.replace(/bytes=/, "").split("-"),
                    start = parseInt(range_start, 10),
                    chunklength = range_end ? parseInt(range_end, 10) - start + 1 : Math.min(1024 * 1024 * 32 /* 32KB default */, size - start /* whats left in the file */),
                    end = start + chunklength - 1

                console.log(`serving video request range: ${range_start} -> ${range_end},  providing ${start} -> ${end} / ${size}`)

                ctx.set('Accept-Ranges', 'bytes');
                ctx.set('Content-Length', chunklength) // 38245154
                ctx.set('Content-Range', `bytes ${start}-${end}/${size}`) // bytes 29556736-67801889/67801890

                streamoptions = { ...streamoptions, start, end }
                ctx.status = 206;
            }
            ctx.body = fs.createReadStream(filepath, streamoptions).on('error', ctx.onerror)
            //ctx.body = fs.createReadStream(filepath, { encoding: null, start, end }).on('error', ctx.onerror).pipe(PassThrough());

        }).get(['/(.*)'], async (ctx, next) => {
            console.log(`serving static: ${ctx.params[0]}`)
            await send(ctx, ctx.params[0] || '/index.html', { root: __dirname + '/build' })
        })

    const api = new Router({ prefix: '/api' })
        .post('/movements', async (ctx, next) => {

            if (ctx.request.body && ctx.request.body.length > 0) {
                const d = new Date()

                const filename = `${webdir}/${process.env.CAMERA_NAME}-${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}.csv`
                console.log(`writing movement ${filename}`)
                await fs.promises.appendFile(filename, ctx.request.body.map(m => `${m.movement_key};${m.video ? m.video.file : "missing"};${m.reviewed || "false"};${m.save || "false"}`).join("\n") + "\n")
                ctx.status = 201
            }
        })
        .get('/movements/:mode*', async (ctx, next) => {

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

                }).filter(i => i.web ? i.web.reviewed === "false" : true)
            } else {
                ctx.body = []
            }
        })

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

    app.use(require('koa-body-parser')())
    app.use(api.routes())
    app.use(nav.routes())
    app.use(static.routes())
    /*
        app.use(async (ctx) => {
            
            })
    */
    console.log(`Starting on 8080..`)
    app.listen(8080)
}

init_movement_poll()
init_web()

