const
    Koa = require('koa'),
    Router = require('koa-router'),
    send = require('koa-send'),
    fs = require('fs'),
    path = require('path'),
    app = new Koa()

//const PassThrough = require('stream').PassThrough;

async function startWeb() {

    var static = new Router()
        .get(['/video/(.*)'], async (ctx, next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `${__dirname}/video/${ctx.params[0]}`
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
            const d = new Date()

            const filename = `${process.env.FILEPATH}/web-${process.env.CAMERA_NAME}-${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}.csv`
            console.log(`writing movement ${filename}`)
            await fs.promises.appendFile(filename, ctx.request.body.map(m => `${m.movement_key};${m.file};${m.reviewed || "false"};${m.save || "false"}`).join("\n") + "\n")
            ctx.status = 201
        })
        .get('/movements', async (ctx, next) => {


            function add_in_order(new_val, array) {

                for (let i in array) {
                    if (!(new_val.start > array[i].start)) {
                        return [...array.slice(0, i), new_val, ...array.slice(i + 1)]
                    }
                }
                return [...array, new_val]
            }

            let sorted_mp4 = []
            const local_video = await fs.promises.readdir(process.env.FILEPATH + "/mp4")
            const local_video_re = new RegExp(`^out-${process.env.CAMERA_NAME}-(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2}).mp4`)
            for (let dir_entry of local_video) {
                const entry_match = dir_entry.match(local_video_re)
                if (entry_match) {
                    const [file, year, month, day, hour, minute, second] = entry_match
                    const start = new Date(year, month - 1, day, hour, minute, second)
                    sorted_mp4 = add_in_order({ start: start.getTime(), file }, sorted_mp4)
                }
            }

            let sorted_mov = []
            const movement_dir = await fs.promises.readdir(process.env.FILEPATH)
            const movement_re = new RegExp(`^mov-${process.env.CAMERA_NAME}-(\\d{4})-(\\d{2})-(\\d{2}).csv`)
            for (let dir_entry of movement_dir) {
                const entry_match = dir_entry.match(movement_re)
                if (entry_match) {
                    const [file, year, month, day] = entry_match
                    if (file) {
                        const data = await fs.promises.readFile(process.env.FILEPATH + '/' + file, 'UTF-8')
                        for (let mov_line of data.split(/\r?\n/)) {
                            const [start, duration] = mov_line.split(';')
                            if (start && duration) {
                                sorted_mov = add_in_order({ start: new Date(start).getTime(), duration, file_key: start }, sorted_mov)
                            }
                        }
                    }
                }
            }

            let mp4_idx = 0
            ctx.body = sorted_mov.map(function (sm) {
                const out = { movement_key: sm.file_key, start: new Date(sm.start).toUTCString().replace(/ \d{4}/, "").replace(/ GMT$/, ""), duration: sm.duration }
                while (mp4_idx < sorted_mp4.length) {
                    const curr_mp4_start = sorted_mp4[mp4_idx].start
                    if (sm.start >= curr_mp4_start) {
                        // movemet time is greater than current mp4 start time
                        const next_mp4_start = (mp4_idx + 1 < sorted_mp4.length) ? sorted_mp4[mp4_idx + 1].start : null
                        if (next_mp4_start === null || sm.start < next_mp4_start) {
                            return { ...out, file: sorted_mp4[mp4_idx].file, index: parseInt((sm.start - curr_mp4_start) / 1000, 10) }
                        } else {
                            // movement time is after or equal the next mp4 start time
                            mp4_idx++
                        }

                    } else {
                        // movemet time is older than current mp4 (mp4 no longer on local disk!)
                        return out
                    }
                }

            })
        })

    app.use(require('koa-body-parser')())
    app.use(api.routes())
    app.use(static.routes())
    /*
        app.use(async (ctx) => {
            
            })
    */
    console.log(`Starting on 8080..`)
    app.listen(8080)
}

startWeb()

