import fs from 'fs/promises'
import { readFile, stat, readdir, mkdir } from 'fs/promises'
import {ChildProcess, ChildProcessWithoutNullStreams, spawn} from 'child_process'
import { timeStamp } from 'console'


async function runDF(folder: string): Promise<{device: string, sizeKB: number, usedKB: number, avaiableKB: number, pecentUsed: number}> {

    return new Promise((acc,rej) => {
        let mv_stdout = '', mv_stderr = '', mv_error = ''
        const mv_task = spawn('df', ['-Pk', folder], { timeout: 5000 })

        mv_task.stdout.on('data', (data: string) => { mv_stdout += data })
        mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
        mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

        mv_task.on('close', async (code: number) => {
            if (code === 0) {
                const [device, sizeKB, usedKB, avaiableKB, pecentUsed] = mv_stdout.split('\n')[1].split(' ').filter(x => x).map((x,i) => i ? parseInt(x): x) as [string, number, number, number, number]
                acc({device, sizeKB, usedKB, avaiableKB, pecentUsed})
            } else {
                rej(code)
            }
        })
    })

}


async function lsOrderTime(folder: string): Promise<Array<[size: number, filename: string]>> {

    return new Promise((acc,rej) => {
        let mv_stdout = '', mv_stderr = '', mv_error = ''
        const mv_task = spawn('ls', ['-trks', folder], { timeout: 5000 })

        // only take the first page of the results, otherwise TOO LONG!
        mv_task.stdout.on('data', (data: string) => { if (!mv_stdout)  mv_stdout += data })
        mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
        mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

        mv_task.on('close', async (code: number) => {
            if (code === 0) {
                //const [device, sizeKB, usedKB, avaiableKB, pecentUsed] = mv_stdout.split('\n')[1].split(' ').filter(x => x).map((x,i) => i ? parseInt(x): x) as [string, number, number, number, number]
                acc(mv_stdout.split('\n').slice(1, -1).map(x => x.split(' ').filter(x => x).map((x,i) => i ? x: parseInt(x))) as Array<[number, string]>)
            } else {
                rej(code)
            }
        })
    })

}


async function needtoRemoveKB(folder: string, cleanIfOver: number): Promise<number> {

    const stats = await stat(folder)
    if (!stats.isDirectory()) {
        throw new Error(`${folder} is not a directory`)
    }

    const {sizeKB, usedKB, pecentUsed} = await runDF(folder)
    console.log(`needtoRemoveKB: sizeKB=${sizeKB}, usedKB=${usedKB}, pecentUsed=${pecentUsed} cleanIfOver=${cleanIfOver}`)
    if (pecentUsed > cleanIfOver) {
        return (pecentUsed - cleanIfOver) * sizeKB / 100
    } else {
        return 0
    }

}

async function diskCheck(folder: string, cleanIfOver: number): Promise<number> {
    
        const stats = await stat(folder)
        if (!stats.isDirectory()) {
            throw new Error(`${folder} is not a directory`)
        }
    
        const needtoReomveKB = await needtoRemoveKB(folder, cleanIfOver)
        console.log(`diskCheck: needtoReomveKB=${needtoReomveKB}`)
        if (needtoReomveKB > 0) {
            let removed = 0
            const files = await lsOrderTime(folder)
            //console.log (`diskCheck: files=${JSON.stringify(files)}`)
            // remove all files except .ts or jpg
            for (let f of files.filter(([s,f]) => f.match(/(\.ts|\.jpg)$/))) {
                if (removed >= needtoReomveKB) {
                    break
                }
                console.log(`diskCheck: removing ${folder}/${f[1]}, needtoReomveKB=${needtoReomveKB}, removed=${removed}`)
                //await fs.rm(`${folder}/${f[1]}`)
                removed += f[0]
            }
            return removed
        } else {
            return 0
        }
    
}



console.log ('diskcheck.ts')
//needtoRemoveKB('.', 95).then(console.log)
diskCheck(process.argv[2] || '.', process.argv[3] ? parseInt(process.argv[3]) :  90).then(r => console.log(`removed=${r}`))
