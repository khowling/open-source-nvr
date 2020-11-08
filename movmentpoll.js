const fs = require('fs')
const http = require('http')

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


async function init() {

    const SECS_WITHOUT_MOVEMENT = 10
    const movdir = `${process.env.FILEPATH}/${process.env.CAMERA_NAME}/mov`

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

init()
