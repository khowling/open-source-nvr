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

interface DiskDeleteStats {
    removedMB: number;
    removedFiles: number;
    lastRemovedctimeMs?: number;
    lastRemovedIdx?: number;
}

export interface DiskCheckReturn {
    revmovedMBTotal: number;
    folderStats: {
        [folder: string]: DiskDeleteStats;
    }
}

// Clear down OLDEST removedFiles on each camera streaming directory, until it is under the cleanIfOver percentage
export async function diskCheck(rootFolder: string, cameraFolders: Array<string>, cleanIfOver: number): Promise<DiskCheckReturn> {
    
        const stats = await stat(rootFolder)
        if (!stats.isDirectory()) {
            throw new Error(`${rootFolder} is not a directory`)
        }
    
        const needtoReomveKB = cleanIfOver ? await needtoRemoveKB(rootFolder, cleanIfOver) : -1
        console.log(`diskCheck: running on rootFolder=${rootFolder}, with cameraFolders=${cameraFolders},  needtoReomveKB=${needtoReomveKB}`)
        if (needtoReomveKB === -1 || needtoReomveKB > 0) {

            let ret = {
                revmovedMBTotal: 0,
                folderStats: {}
            } as DiskCheckReturn

            // need to keep track of the oldest current file across all camera directories, so we can delete them in oldest order
            let flist : {[folder: string]: Array<[size: number, filename: string]>} = {}, 
                flist_pointer : {[folder: string]: {idx: number, age: number}} = {}

            // find folder with oldest camera flist, then remove needtoReomveKB from that folder!
            // first, for each folder, get the oldest file index=0, & set the age of the file
            for (let folder of cameraFolders) {

                const stats = await stat(folder)
                if (!stats.isDirectory()) {
                    throw new Error(`${folder} is not a directory`)
                }

                ret.folderStats[folder] = {removedMB: 0, removedFiles: 0} as DiskDeleteStats

                flist[folder] = (await lsOrderTime(folder)).filter(([,f]) => f.match(/(\.ts|\.jpg)$/))
                if (flist[folder].length) {
                    flist_pointer[folder] = {idx: 0, age: (await fs.stat(`${folder}/${flist[folder][0][1]}`)).ctimeMs}
                }
            }

            // Next, find the next oldest file across all folders, do this by finding the creationTime (ctime), of the oldest remaining file in each directory, 
            // then, the reduce will tell us which folder has the oldest file, and we can remove that file from that folder
            // and delete it, until either we have deleted enough, or there are no more files to delete
            while ((ret.revmovedMBTotal < needtoReomveKB || needtoReomveKB === -1  ) && Object.keys(flist_pointer).length > 0) {
                // get next oldest across all folders (of there is only one folder, we dont need to reduce, it must be the one folder)
                let { folder, idx, age } = Object.keys(flist_pointer).length === 1 ? {folder: Object.keys(flist_pointer)[0], ...flist_pointer[Object.keys(flist_pointer)[0]]} : Object.keys(flist_pointer).reduce((acc, folder) => acc.age ? (flist_pointer[folder].age < acc.age ? {folder,...flist_pointer[folder]} : acc ): {folder, ...flist_pointer[folder]} , {folder: '', idx: -1, age: 0 })
                const [size, filename] = flist[folder][idx]
                const isLastFileTobeDeleted = ret.revmovedMBTotal + size >= needtoReomveKB

                // last file that needed to be deleted, and we are not deleting everything, so we need to ensure we have a file date to retrun
                if (isLastFileTobeDeleted && needtoReomveKB > 0 && age === 0) {
                    age = (await fs.stat(`${folder}/${filename}`)).ctimeMs
                }

                //console.log(`diskCheck: removing ${folder}/${filename}, needtoReomveKB=${needtoReomveKB}, removedMB=${removedMB}`)
                //try {
                    await fs.rm(`${folder}/${filename}`)
                    ret = {
                        revmovedMBTotal: ret.revmovedMBTotal + size, 
                        folderStats: {...ret.folderStats, [folder]: {removedMB: ret.folderStats[folder].removedMB + size, removedFiles: ret.folderStats[folder].removedFiles + 1, lastRemovedctimeMs: age, lastRemovedIdx: idx}}
                    }
                //} catch (e) {
                //    console.warn (`diskCheck: error removing ${folder}/${filename}`, e)
                //}

                
                // set next oldest index in the folder "flist_pointer" (dont need to calculed age if there is only one folder left)
                if (flist[folder].length > idx + 1) {
                    if (Object.keys(flist_pointer).length > 1) {
                        flist_pointer[folder] = {idx: idx + 1, age: (await fs.stat(`${folder}/${flist[folder][idx + 1][1]}`)).ctimeMs}
                    } else {
                        flist_pointer[folder] = {idx: idx + 1, age: 0 }
                    }
                } else {
                    // no more files in the folder to delete, so just delete the folder key
                    delete flist_pointer[folder]
                }

            }

            return ret
        } else {
            return { revmovedMBTotal: 0, folderStats:{} }
        }
    
}

export async function catalogVideo (cameraFolder: string): Promise<Array<{ctimeMs: number, startDate_en_GB: string, segmentStart: number, seqmentEnd: number, seconds: number}>> {

    const re = new RegExp(`stream([\\d]+).ts`, 'g');

    let flist : Array<[size: number, filename: string]>, 
        flist_result : Array<{ctimeMs: number, startDate_en_GB: string, segmentStart: number, seqmentEnd: number, seconds: number}> = [],
        lastSeq,
        currentRes = null



        const stats = await stat(cameraFolder)
        if (!stats.isDirectory()) {
            throw new Error(`${cameraFolder} is not a directory`)
        }

        flist = (await lsOrderTime(cameraFolder)).filter(([,f]) => f.match(/(\.ts)$/))

        for (let idx = 0; idx < flist.length; idx++) {

            const [,filename] = flist[idx]
            const currentSeg = parseInt([...filename.matchAll(re)][0][1])

            if (currentRes) {
                // If continuation of a series, and we are less than 1hour in length, and we are not on the last file
                if (currentSeg === lastSeq+1 && ((currentSeg - currentRes.segmentStart)+1) <= ((60*60)/2) && (idx+1) < flist.length) {// got a continuation sequence that is under 30mins long
                    lastSeq = currentSeg
                } else { // must be new sequence, safe old, and start a new
                    flist_result = flist_result.concat({...currentRes, seqmentEnd: lastSeq, seconds: ((lastSeq - currentRes.segmentStart) + 1)*2})
                    currentRes = null
                }
            }

            if (!currentRes) {
                
                const ctimeMs = (await fs.stat(`${cameraFolder}/${filename}`)).ctimeMs
                currentRes = {
                    ctimeMs,
                    startDate_en_GB: new Intl.DateTimeFormat('en-GB', { weekday: "short", minute: "2-digit", hour: "2-digit",  hour12: true }).format(new Date(ctimeMs)),
                    segmentStart: currentSeg
                }
                lastSeq = currentSeg
            }
        }
        return flist_result
}
