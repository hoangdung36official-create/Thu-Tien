import { setTimeout as delay } from 'node:timers/promises';
import { db } from './db.js';
import { env } from './env.js';
import { runSyncCycle } from './sync.js';

let stopping=false;
const aborter=new AbortController();
function requestStop(){stopping=true;aborter.abort();}
process.on('SIGINT',requestStop);
process.on('SIGTERM',requestStop);

while(!stopping){
  try{
    const result=await runSyncCycle();
    await db.syncState.upsert({where:{key:'lastError'},create:{key:'lastError',value:''},update:{value:''}});
    console.info('Đồng bộ Sheets',result);
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    await db.syncState.upsert({where:{key:'lastError'},create:{key:'lastError',value:message},update:{value:message}});
    console.error('Đồng bộ Sheets lỗi',message);
  }
  if(stopping)break;
  try{await delay(env.SHEET_POLL_SECONDS*1000,undefined,{signal:aborter.signal});}
  catch(e){if(!stopping)throw e;}
}
await db.$disconnect();
