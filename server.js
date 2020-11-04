async function startWeb() {
    const
        Koa = require('koa'),
        fs = require('fs'),
        path = require('path'),
        app = new Koa()

    app.use(require('koa-static')('./public'))
    app.use(require('koa-static')('/video/mp4', { index: false }))
    console.log(`Starting on 8080..`)
    app.listen(8080)
}

startWeb()

