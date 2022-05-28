import fs from 'fs'
import { readFile, stat, readdir, mkdir } from 'fs/promises'
import {ChildProcess, ChildProcessWithoutNullStreams, spawn} from 'child_process'


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


async function lsOrderTime(folder: string): Promise<Array<[number, string]>> {

    return new Promise((acc,rej) => {
        let mv_stdout = '', mv_stderr = '', mv_error = ''
        const mv_task = spawn('ls', ['-trks', folder], { timeout: 5000 })

        mv_task.stdout.on('data', (data: string) => { 
            console.log (`adding: ${data}`)
            mv_stdout += data }
        )
        mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
        mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

        mv_task.on('close', async (code: number) => {
            if (code === 0) {
                //const [device, sizeKB, usedKB, avaiableKB, pecentUsed] = mv_stdout.split('\n')[1].split(' ').filter(x => x).map((x,i) => i ? parseInt(x): x) as [string, number, number, number, number]
                acc(mv_stdout.split('\n').slice(1).map(x => x.split(' ').filter(x => x).map((x,i) => i ? x: parseInt(x))) as Array<[number, string]>)
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
    if (pecentUsed > cleanIfOver) {
        return (pecentUsed - cleanIfOver) * sizeKB / 100
    } else {
        return 0
    }

}
console.log ('diskcheck.ts')
//needtoRemoveKB('.', 95).then(console.log)
lsOrderTime('.').then(console.log)
