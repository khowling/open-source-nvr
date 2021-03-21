const http = require('http')


export default async function (url: string, method = 'GET', headers = {}, body?: string): Promise<any> {
    const opts: any = { method, headers }

    if (body) {
        opts.headers['content-length'] = Buffer.byteLength(body)
    }

    return new Promise(function (resolve, reject) {
        const req = http.request(url, opts, (res: any) => {

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
                var strings: string[] = []
                res.on('data', function (chunk: string) {
                    strings.push(chunk)
                })
                res.on('end', () => {

                    if (strings.length === 0) {
                        resolve(0)
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
        }).on('error', (e: any) => {
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