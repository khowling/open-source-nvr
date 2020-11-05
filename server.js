const
    Koa = require('koa'),
    Router = require('koa-router'),
    send = require('koa-send'),
    fs = require('fs'),
    path = require('path'),
    app = new Koa()

//const PassThrough = require('stream').PassThrough;

async function startWeb() {

    var router = new Router()
    router.get(['/video/(.*)'], async (ctx, next) => {
        const filepath = `${__dirname}/video/${ctx.params[0]}`

        const { size } = await fs.promises.stat(filepath)

        const [range_start, range_end] = ctx.headers.range.replace(/bytes=/, "").split("-"),
            start = parseInt(range_start, 10),
            maxchunk = Math.min(1024 * 1024 * 32, size - start - 1),
            end = range_end ? parseInt(range_end, 10) : start + maxchunk

        console.log(`video request range: ${range_start} -> ${range_end},  providing ${start} -> ${end} / ${size}`)

        ctx.set('Accept-Ranges', 'bytes');
        ctx.set('Content-Length', end - start + 1) // 38245154
        ctx.set('Content-Range', `bytes ${start}-${end}/${size}`) // bytes 29556736-67801889/67801890
        //ctx.set('Content-Type', 'video/mp4');

        ctx.status = 206;
        ctx.body = fs.createReadStream(filepath, { encoding: null, start, end })//.on('end', () => console.log('done'))
        //ctx.body = fs.createReadStream(filepath, { encoding: null, start, end }).on('error', ctx.onerror).pipe(PassThrough());

    }).get(['/(.*)'], async (ctx, next) => {
        console.log(ctx.params[0])
        await send(ctx, ctx.params[0] || '/index.html', { root: __dirname + '/build' })
    })

    app.use(router.routes())
    /*
        app.use(async (ctx) => {
            
            })
    */
    console.log(`Starting on 8080..`)
    app.listen(8080)
}

startWeb()

