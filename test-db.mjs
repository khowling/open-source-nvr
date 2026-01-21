import { Level } from 'level';

const db = new Level('./mydb', { valueEncoding: 'json' });
const movementdb = db.sublevel('movements', { valueEncoding: 'json' });

console.log('Starting iteration...');

let count = 0;
const startTime = Date.now();
for await (const [key, value] of movementdb.iterator({ reverse: true })) {
    count++;
    if (count <= 5) {
        console.log(`${count}: key=${key}`);
    }
    if (count % 1000 === 0) {
        console.log(`Processed ${count} entries...`);
    }
}

console.log(`Done! Total entries: ${count}, Time: ${Date.now() - startTime}ms`);

await db.close();
