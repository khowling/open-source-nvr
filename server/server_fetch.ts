import http from 'http'


export default async function (url: string, opts = {} as http.RequestOptions, body?: string | object): Promise<any> {

    let options = {method: body? 'POST' : 'GET',  ...opts }
    let bodystr: string 

    if (body) {
        bodystr = typeof body === 'object'? JSON.stringify(body) : body

        if (typeof body === 'object' && !options.headers?.hasOwnProperty('content-type')) {
            options = {...options, headers: {...options.headers, 'content-type': 'application/json'}}
        }
        if (!options.headers?.hasOwnProperty('content-length')) {
            options = {...options, headers: {...options.headers, 'content-length': Buffer.byteLength(bodystr)}}
        }
    }

    return new Promise(function (resolve, reject) {
        const req = http.request(url, options, (res: any) => {

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
                                reject(new Error(e as string))
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
            //console.error(`server_fetch: ${e.message}`)
            reject(e)
        }).on('timeout', () => {
            reject(new Error(`network request timeout url=${url}`))
            req.destroy()
        })

        // Set timeout if specified in options
        if (options.timeout) {
            req.setTimeout(options.timeout);
        }

        if (options.method === 'POST' || options.method === 'PUT') {
            // Write data to request body
            req.end(bodystr)
        } else {
            req.end()
        }

    })
}