import fs from 'fs/promises'
import { stat } from 'fs/promises'
import { spawn } from 'child_process'


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
        const mv_task = spawn('ls', ['-trks', '--ignore=\'*[^.jpg|^.ts]\'' , folder], { timeout: 5000 })

        // only take the first page of the results, otherwise TOO LONG!
        mv_task.stdout.on('data', (data: string) => { /*if (!mv_stdout) */ mv_stdout += data })
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

// Clear down OLDEST removedFiles on each camera streaming directory, until it is under the cleanIfOver percentage
export async function diskCheck(rootFolder: string, cameraFolders: Array<string>, cleanIfOver: number): Promise<{removedFiles: number, removedMB: number}> {
    
        const stats = await stat(rootFolder)
        if (!stats.isDirectory()) {
            throw new Error(`${rootFolder} is not a directory`)
        }
    
        const needtoReomveKB = await needtoRemoveKB(rootFolder, cleanIfOver)
        console.log(`diskCheck: running on rootFolder=${rootFolder}, with cameraFolders=${cameraFolders},  needtoReomveKB=${needtoReomveKB}`)
        if (needtoReomveKB > 0) {

            let removedMB = 0, removedFiles = 0

            // need to keep track of the oldest current file across all camera firectories, so we can delete them in oldest order
            let flist : {[folder: string]: Array<[size: number, filename: string]>} = {}, 
                fages : {[folder: string]: {idx: number, age: number}} = {}

            // find folder with oldest camera flist, then remove needtoReomveKB from that folder!
            // first, for each folder, get the oldest file index=0, & set the age of the file
            for (let folder of cameraFolders) {

                const stats = await stat(folder)
                if (!stats.isDirectory()) {
                    throw new Error(`${folder} is not a directory`)
                }

                flist[folder] = (await lsOrderTime(folder)).filter(([,f]) => f.match(/(\.ts|\.jpg)$/))
                if (flist[folder].length) {
                    fages[folder] = {idx: 0, age: (await fs.stat(`${folder}/${flist[folder][0][1]}`)).ctimeMs}
                }
            }

            // Next, find the next oldest file across all folders, do this by finding the creationTime (ctime), of the oldest remaining file in each directory, 
            // then, the reduce will tell us which folder has the oldest file, and we can remove that file from that folder
            // and delete it, until either we have deleted enough, or there are no more files to delete
            while (removedMB < needtoReomveKB && Object.keys(fages).length > 0) {
                // get next oldest across all folders (of there is only one folder, we dont need to reduce, it must be the one folder)
                const { folder, idx, age } = Object.keys(fages).length === 1 ? {folder: Object.keys(fages)[0], ...fages[Object.keys(fages)[0]]} : Object.keys(fages).reduce((acc, folder) => acc.age ? (fages[folder].age < acc.age ? {folder,...fages[folder]} : acc ): {folder, ...fages[folder]} , {folder: '', idx: -1, age: 0 })

                const [size, filename] = flist[folder][idx]

                //console.log(`diskCheck: removing ${folder}/${filename}, needtoReomveKB=${needtoReomveKB}, removedMB=${removedMB}`)
                await fs.rm(`${folder}/${filename}`)
                removedMB += size
                removedFiles++
                
                // set next oldest index in the folder "fages" (dont need to calculed age if there is only one folder left)
                if (flist[folder].length > idx + 1) {
                    if (Object.keys(fages).length > 1) {
                        fages[folder] = {idx: idx + 1, age: (await fs.stat(`${folder}/${flist[folder][idx + 1][1]}`)).ctimeMs}
                    } else {
                        fages[folder] = {idx: idx + 1, age: 0 }
                    }
                } else {
                    // no more files in the folder to delete, so just delete the folder key
                    delete fages[folder]
                }

            }

            return {removedFiles, removedMB}
        } else {
            return { removedFiles: 0, removedMB: 0 }
        }
    
}



//console.log ('diskcheck.ts')
//needtoRemoveKB('.', 95).then(console.log)
//diskCheck(process.argv[2] || '/video', ['/video/front', '/video/back'] , process.argv[3] ? parseInt(process.argv[3]) :  90).then(console.log)
